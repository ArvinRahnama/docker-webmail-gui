/**
 * Per-mailbox sender allow/block lists (docker/dms/README.md).
 *
 * An allowed sender's mail is never filed in Junk for that mailbox; a
 * blocked sender's always is. Spam is never *rejected* either way — the
 * docker-mailserver integration switches Rspamd's reject off and files
 * spam in Junk. The lists change two ways:
 *
 *  - an administrator edits them here, or
 *  - the mailbox's own user reports a message from their mail client:
 *    moving it out of Junk ("not spam") allows the sender, moving it into
 *    Junk ("spam" — blocking it) blocks the sender and lifts any allow.
 *    {@link SenderListsService.applyReport} handles those, fed by
 *    `sender-report-collector.ts`.
 *
 * Storage is the mailbox's own `dwg-sender-lists` Sieve script, which is
 * also what the mail server enforces (`sender-lists-sieve.ts`); this
 * service reads, edits and rewrites it, and never activates it.
 */
import {
  SENDER_LIST_MAX_ENTRIES,
  validateAddressForArgv,
  validateDomain,
  validateIpAddress,
  type AddSenderListEntryRequest,
  type RemoveSenderListEntryRequest,
  type SenderEntryKind,
  type SenderEntrySource,
  type SenderList,
  type SenderListEntry,
  type SenderListsResponse,
  type SenderReport,
  type SpamIntegrationStatus,
} from '@dwg/shared';
import { createHash } from 'node:crypto';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { DmsCommandExecutionError } from '../../drivers/dms/errors.js';
import {
  SENDER_LISTS_SCRIPT_NAME,
  generateSenderListsSieve,
  parseSenderListsSieve,
} from '../../drivers/dms/sender-lists-sieve.js';
import type { ParsedSenderReport } from '../../drivers/dms/maillog-parser.js';
import { validateSieveScriptContent } from '../../drivers/dms/sieve-validator.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';

/**
 * Domains shared by unrelated people. A report about one Gmail user must
 * never allow or block all of Gmail, so for these (and for this server's
 * own domains) a report records the full address instead of the domain.
 */
export const SHARED_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  'mail.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'tutanota.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
]);

export interface SenderTarget {
  readonly kind: SenderEntryKind;
  readonly value: string;
}

/**
 * What a report about `from` (and the client `ip`) should allow or block:
 * the sender's domain; the full address for a shared or local domain;
 * the client IP only when the message carried no usable From address.
 */
export function reportTarget(
  from: string | null,
  ip: string | null,
  localDomains: ReadonlySet<string>,
): SenderTarget | null {
  if (from !== null && from.includes('@')) {
    const domain = from.slice(from.lastIndexOf('@') + 1);
    if (validateDomain(domain) === null) {
      const shared = SHARED_MAILBOX_DOMAINS.has(domain) || localDomains.has(domain);
      if (!shared) return { kind: 'domain', value: domain };
      if (validateAddressForArgv(from) === null) return { kind: 'address', value: from };
      return null;
    }
  }
  if (ip !== null && validateIpAddress(ip) === null) return { kind: 'ip', value: ip };
  return null;
}

export type UpsertResult =
  | { readonly ok: true; readonly entries: SenderListEntry[]; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Puts `kind`/`value` on `list`, taking it off the other list if it was
 * there — a sender is allowed or blocked, never both. A report never
 * overrides an administrator's identical entry on the same list. When the
 * mailbox is at {@link SENDER_LIST_MAX_ENTRIES}, the oldest reported entry
 * makes room; administrator entries are never evicted.
 */
export function upsertEntry(
  entries: readonly SenderListEntry[],
  list: SenderList,
  target: SenderTarget,
  source: SenderEntrySource,
  now: Date,
): UpsertResult {
  const existing = entries.find((e) => e.kind === target.kind && e.value === target.value);
  if (existing !== undefined && existing.list === list) {
    if (existing.source === 'admin' || source === 'report') {
      return { ok: true, entries: [...entries], changed: false };
    }
  }

  let next = entries.filter((e) => e !== existing);
  if (next.length >= SENDER_LIST_MAX_ENTRIES) {
    const oldestReport = next
      .filter((e) => e.source === 'report')
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt))[0];
    if (oldestReport === undefined) {
      return {
        ok: false,
        reason: `This mailbox already has ${SENDER_LIST_MAX_ENTRIES} sender list entries, all added by an administrator. Remove one first.`,
      };
    }
    next = next.filter((e) => e !== oldestReport);
  }

  next.push({ list, kind: target.kind, value: target.value, source, addedAt: now.toISOString() });
  return { ok: true, entries: next, changed: true };
}

function describe(target: SenderTarget): string {
  return `${target.kind === 'ip' ? 'IP' : target.kind} ${target.value}`;
}

interface SenderReportRow {
  readonly reported_at: string;
  readonly mailbox: string;
  readonly action: 'ham' | 'spam';
  readonly sender: string | null;
  readonly client_ip: string | null;
  readonly list: SenderList | null;
  readonly kind: SenderEntryKind | null;
  readonly value: string | null;
  readonly outcome: string;
}

/** How long processed-report rows are kept for the activity view. */
const REPORT_RETENTION_DAYS = 90;
/** Log lines older than the newest processed report minus this are ignored, so a line can never be applied twice even after its dedupe row is pruned. */
const REPORT_REPLAY_MARGIN_MS = 60 * 60_000;

export class SenderListsService {
  constructor(
    private readonly dmsDriver: DmsDriver,
    private readonly db: Database,
  ) {}

  async integration(): Promise<SpamIntegrationStatus> {
    return this.dmsDriver.getSpamIntegration();
  }

  private assertMailbox(mailbox: string): void {
    const error = validateAddressForArgv(mailbox);
    if (error !== null) throw new AppError('VALIDATION_FAILED', error);
  }

  private async read(
    mailbox: string,
  ): Promise<{ entries: SenderListEntry[]; unrecognisedContent: boolean }> {
    const scripts = await this.dmsDriver.sieveList(mailbox);
    if (!scripts.some((script) => script.name === SENDER_LISTS_SCRIPT_NAME)) {
      return { entries: [], unrecognisedContent: false };
    }
    const parsed = parseSenderListsSieve(
      await this.dmsDriver.sieveGet(mailbox, SENDER_LISTS_SCRIPT_NAME),
    );
    return parsed === null
      ? { entries: [], unrecognisedContent: true }
      : { entries: parsed, unrecognisedContent: false };
  }

  private async write(mailbox: string, entries: readonly SenderListEntry[]): Promise<void> {
    const script = generateSenderListsSieve(mailbox, entries);
    // Same content check every hand-written script passes (sieve-validator.ts).
    const validation = validateSieveScriptContent(script);
    if (!validation.ok) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Generated sender-lists script failed validation: ${validation.reason ?? 'unknown reason'}`,
      );
    }
    try {
      await this.dmsDriver.sievePut({
        user: mailbox,
        script: SENDER_LISTS_SCRIPT_NAME,
        content: script,
      });
    } catch (err) {
      if (err instanceof DmsCommandExecutionError) {
        throw new AppError(
          'VALIDATION_FAILED',
          err.stderr.trim().length > 0
            ? err.stderr.trim()
            : 'Dovecot rejected the generated script.',
        );
      }
      throw err;
    }
  }

  async get(mailbox: string): Promise<SenderListsResponse> {
    this.assertMailbox(mailbox);
    const [integration, current] = await Promise.all([this.integration(), this.read(mailbox)]);
    return {
      mailbox,
      integration,
      entries: current.entries,
      unrecognisedContent: current.unrecognisedContent,
      maxEntries: SENDER_LIST_MAX_ENTRIES,
    };
  }

  async add(
    mailbox: string,
    request: AddSenderListEntryRequest,
    now: Date = new Date(),
  ): Promise<SenderListsResponse> {
    this.assertMailbox(mailbox);
    const { entries } = await this.read(mailbox);
    const result = upsertEntry(entries, request.list, request, 'admin', now);
    if (!result.ok) throw new AppError('CONFLICT', result.reason);
    if (result.changed) await this.write(mailbox, result.entries);
    return this.get(mailbox);
  }

  async remove(
    mailbox: string,
    request: RemoveSenderListEntryRequest,
  ): Promise<SenderListsResponse> {
    this.assertMailbox(mailbox);
    const { entries } = await this.read(mailbox);
    const next = entries.filter(
      (e) => !(e.list === request.list && e.kind === request.kind && e.value === request.value),
    );
    if (next.length === entries.length) {
      throw new AppError(
        'NOT_FOUND',
        `${describe(request)} is not on this mailbox's ${request.list} list.`,
      );
    }
    await this.write(mailbox, next);
    return this.get(mailbox);
  }

  /** The newest report already applied — the replay cursor (migration 009's comment). */
  private latestReportedAt(): string | null {
    const row = this.db.get<{ at: string | null }>(
      'SELECT MAX(reported_at) AS at FROM sender_reports',
    );
    return row?.at ?? null;
  }

  /**
   * Applies every report not yet applied, oldest first, and returns what
   * each did. Reports are idempotent by log line, and lines older than the
   * cursor are skipped, so feeding the same log tail twice is harmless. If
   * the mail server cannot be reached part-way, the reports applied so far
   * are kept and the error propagates; the rest are picked up next time.
   */
  async applyReports(
    reports: readonly ParsedSenderReport[],
    now: Date = new Date(),
  ): Promise<SenderReport[]> {
    const cursor = this.latestReportedAt();
    const cutoff = cursor === null ? null : Date.parse(cursor) - REPORT_REPLAY_MARGIN_MS;
    const pending = reports
      .filter((r) => cutoff === null || Date.parse(r.at) >= cutoff)
      .map((r) => ({ report: r, hash: createHash('sha256').update(r.line).digest('hex') }))
      .filter(
        ({ hash }) =>
          this.db.get('SELECT 1 FROM sender_reports WHERE line_hash = ?', [hash]) === undefined,
      )
      .sort((a, b) => a.report.at.localeCompare(b.report.at));

    if (pending.length === 0) return [];

    const localDomains = new Set((await this.dmsDriver.listDomains()).map((d) => d.domain));
    const applied: SenderReport[] = [];
    for (const { report, hash } of pending) {
      const result = await this.applyOne(report, localDomains, now);
      this.db.run(
        `INSERT OR IGNORE INTO sender_reports
           (line_hash, reported_at, mailbox, action, sender, client_ip, list, kind, value, outcome, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hash,
          result.reportedAt,
          result.mailbox,
          result.action,
          result.sender,
          result.clientIp,
          result.list,
          result.kind,
          result.value,
          result.outcome,
          now.toISOString(),
        ],
      );
      applied.push(result);
    }
    this.db.run('DELETE FROM sender_reports WHERE reported_at < ?', [
      new Date(now.getTime() - REPORT_RETENTION_DAYS * 86_400_000).toISOString(),
    ]);
    return applied;
  }

  private async applyOne(
    report: ParsedSenderReport,
    localDomains: ReadonlySet<string>,
    now: Date,
  ): Promise<SenderReport> {
    const base = {
      reportedAt: report.at,
      mailbox: report.user,
      action: report.action,
      sender: report.from,
      clientIp: report.ip,
    };
    const nothing = (outcome: string): SenderReport => ({
      ...base,
      list: null,
      kind: null,
      value: null,
      outcome,
    });

    if (validateAddressForArgv(report.user) !== null) {
      return nothing('Ignored: the reporting user is not a valid mailbox address.');
    }
    const target = reportTarget(report.from, report.ip, localDomains);
    if (target === null) {
      return nothing(
        'Ignored: the message had no sender address or client IP that could be listed.',
      );
    }

    const list: SenderList = report.action === 'ham' ? 'allow' : 'block';
    try {
      const { entries } = await this.read(report.user);
      const result = upsertEntry(entries, list, target, 'report', now);
      if (!result.ok) return nothing(`Not applied: ${result.reason}`);
      if (!result.changed) {
        return {
          ...base,
          list,
          kind: target.kind,
          value: target.value,
          outcome: `Already ${list === 'allow' ? 'allowed' : 'blocked'}: ${describe(target)}.`,
        };
      }
      await this.write(report.user, result.entries);
      const verb = list === 'allow' ? 'Allowed' : 'Blocked';
      const moved = entries.some((e) => e.kind === target.kind && e.value === target.value);
      return {
        ...base,
        list,
        kind: target.kind,
        value: target.value,
        outcome: `${verb} ${describe(target)}${moved ? ` (was ${list === 'allow' ? 'blocked' : 'allowed'})` : ''}.`,
      };
    } catch (err) {
      // A refusal of the content is final and recorded. Anything else (the
      // mail server or broker unreachable) propagates, so applyReports stops
      // and this report is retried on the next pass instead of being lost.
      if (err instanceof AppError && err.code === 'VALIDATION_FAILED') {
        return nothing(`Not applied: ${err.message}`);
      }
      throw err;
    }
  }

  listReports(mailbox: string | null, limit = 100): SenderReport[] {
    const rows =
      mailbox === null
        ? this.db.all<SenderReportRow>(
            'SELECT * FROM sender_reports ORDER BY reported_at DESC LIMIT ?',
            [limit],
          )
        : this.db.all<SenderReportRow>(
            'SELECT * FROM sender_reports WHERE mailbox = ? ORDER BY reported_at DESC LIMIT ?',
            [mailbox, limit],
          );
    return rows.map((row) => ({
      reportedAt: row.reported_at,
      mailbox: row.mailbox,
      action: row.action,
      sender: row.sender,
      clientIp: row.client_ip,
      list: row.list,
      kind: row.kind,
      value: row.value,
      outcome: row.outcome,
    }));
  }
}
