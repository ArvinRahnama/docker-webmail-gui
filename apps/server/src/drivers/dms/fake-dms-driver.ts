/**
 * Deterministic, in-memory {@link DmsDriver} seeded from fixtures
 * (`fixtures/index.ts`). Touches no file system, no exec, no broker.
 * **The development default** — see `create-dms-driver.ts` — so the panel
 * is fully developable without a running docker-mailserver container.
 *
 * Every write method runs its input through the *same* `commands.ts`
 * builder `RealDmsDriver` would use, so an invalid call is rejected
 * identically by both implementations — only a validated call ever
 * reaches this class's own in-memory bookkeeping. That bookkeeping models
 * DMS's own confirmed write semantics where the research doc is explicit
 * (e.g. ★4's account-delete side effects: quota entry and pointing
 * aliases are always removed alongside the account). Where the doc is
 * silent on an edge case (e.g. whether `email add` on an already-existing
 * address is rejected or silently overwrites), this class makes the
 * conservative choice — reject — and says so in a comment, rather than
 * presenting an invented behaviour as researched fact.
 */
import {
  DmsAliasAddRequestSchema,
  DmsAliasDeleteRequestSchema,
  DmsDkimGenerateRequestSchema,
  DmsEmailAddRequestSchema,
  DmsEmailDeleteRequestSchema,
  DmsEmailRestrictRequestSchema,
  DmsEmailUpdateRequestSchema,
  DmsFail2banBanRequestSchema,
  DmsFail2banUnbanRequestSchema,
  DmsQuotaDeleteRequestSchema,
  DmsQuotaSetRequestSchema,
  DmsSieveActivateRequestSchema,
  DmsSieveDeactivateRequestSchema,
  DmsSieveGetRequestSchema,
  DmsSieveListRequestSchema,
  DmsSievePutRequestSchema,
} from '@dwg/shared';
import { assertValidDmsRequest as assertValid } from './request.js';
import {
  type AddAliasParams,
  type AddMailboxParams,
  type ConfigDkimParams,
  type DeleteAliasParams,
  type DeleteMailboxParams,
  type DeleteQuotaParams,
  type Fail2banIpParams,
  type RestrictMailboxParams,
  type RestrictScope,
  type SetQuotaParams,
  type SievePutParams,
  type SieveScriptParams,
  type SieveUserParams,
  type UpdateMailboxPasswordParams,
} from './params.js';
import { detectCapabilities, type DmsCapabilities } from './capabilities.js';
import { deriveDomains, type DerivedDomain } from './domains.js';
import { DmsCommandExecutionError, DmsCommandValidationError } from './errors.js';
import {
  FIXTURE_DMS_ENV,
  FIXTURE_DOVECOT_QUOTAS_CF,
  FIXTURE_POSTFIX_ACCOUNTS_CF,
  FIXTURE_POSTFIX_RECEIVE_ACCESS_CF,
  FIXTURE_POSTFIX_SEND_ACCESS_CF,
  FIXTURE_POSTFIX_VIRTUAL_CF,
  FIXTURE_POSTQUEUE_JSON,
} from './fixtures/index.js';
import type { ParseResult } from './parsers/parse-result.js';
import { parseDovecotQuotas, type DovecotQuotaEntry } from './parsers/dovecot-quotas.js';
import { parsePostfixAccounts, type PostfixAccountEntry } from './parsers/postfix-accounts.js';
import { parsePostfixVirtual, type PostfixVirtualEntry } from './parsers/postfix-virtual.js';
import {
  isRestrictAction,
  parsePostfixAccess,
  type PostfixAccessEntry,
} from './parsers/postfix-access.js';
import { parsePostqueueJson, type MailQueueEntry } from './parsers/postqueue.js';
import { parseQuotaToBytes, type QuotaUsageResult } from './quota-usage.js';
import type { Fail2banListResult } from './fail2ban-parser.js';
import type { SieveScriptSummary } from './sieve-list-parser.js';
import type { ClamavReadResult, DkimRecordReadResult, DmsDriver } from './types.js';

/** Deterministic, fixture-only clamd `VERSION` reply — same shape a real deployment's clamd would send, never live data (mirrors `FAKE_PASSWORD_HASH_MARKER`'s own "obviously fake" convention below). */
const FIXTURE_CLAMAV_VERSION = 'ClamAV 0.103.11/27000/Fri Aug 14 08:00:00 2026';
/** Deliberately shaped like real `STATS` output (`POOLS:`/`STATE:`/`THREADS:`/`QUEUE:` lines per `docs/research/03-mail-stack-components.md` §2) without claiming to be a captured sample — free text this project never parses regardless (`clamav-parser.ts`). */
const FIXTURE_CLAMAV_STATS = [
  'POOLS: 1',
  '',
  'STATE: VALID PRIMARY',
  'THREADS: live 1  idle 0 max 12 idle-timeout 30',
  'QUEUE: 0 items',
  '',
  'MEMSTATS: N/A',
  'END',
].join('\n');
/** One fixture "detection" line the fake's `clamavLogTail` returns, so `countClamavDetections` has something real to find in development without a live container's log. */
const FIXTURE_CLAMAV_LOG = [
  'Aug 14 09:00:00 mail clamd[1]: /var/mail/example.com/user/tmp/eicar.txt: Eicar-Test-Signature FOUND',
  'Aug 14 09:00:01 mail clamd[1]: /var/mail/example.com/user/tmp/clean.txt: OK',
].join('\n');

/** Marker hash the fake writes for a freshly-added/updated mailbox. Never a real `doveadm pw` digest — this project never computes real password hashes (FEATURE_MATRIX.md §6). */
const FAKE_PASSWORD_HASH_MARKER = '{FAKE-HASH-DEV-ONLY}';

/** Marker public-key body the fake writes for a "generated" DKIM key. Never real key material — mirrors {@link FAKE_PASSWORD_HASH_MARKER}'s own honesty convention (FEATURE_MATRIX.md §11: private keys are never modelled here at all, only this fixture-only public-record stand-in). */
const FAKE_DKIM_PUBLIC_KEY_MARKER = '{FAKE-DKIM-PUBKEY-DEV-ONLY}';

const DEFAULT_DKIM_SELECTOR = 'mail';
const DEFAULT_DKIM_KEYSIZE = 2048;

interface FakeDkimKeyState {
  readonly selector: string;
  readonly keysize: number;
}

/** Stable, non-cryptographic hex string derived from `input` — same input always yields the same output, so a fixture "public key" looks consistent across repeated reads without being, or resembling, real key material. */
function stableHex(input: string, length: number): string {
  let state = 0;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (state * 33 + input.charCodeAt(i % input.length) + i) >>> 0;
    out += (state % 16).toString(16);
  }
  return out;
}

/** Throws {@link DmsCommandValidationError} for a rejected `commands.ts` result; otherwise a no-op. Every write method below calls this *before* touching any in-memory state, so a rejected call never partially mutates anything. */
/** Re-derives `{localPart, domain}` for a value `commands.ts` has already validated as `local@domain` — used only when constructing a brand-new fixture entry, never on unvalidated input. */
function splitForFixture(email: string): { localPart: string; domain: string } {
  const atIndex = email.lastIndexOf('@');
  return { localPart: email.slice(0, atIndex), domain: email.slice(atIndex + 1).toLowerCase() };
}

/** Like {@link splitForFixture} but also accepts an already-validated catch-all (`@domain`). */
function splitAliasForFixture(address: string): { localPart: string; domain: string } {
  if (address.startsWith('@')) return { localPart: '', domain: address.slice(1).toLowerCase() };
  return splitForFixture(address);
}

const DEFAULT_FIXTURE_QUOTA_BYTES = 1024 ** 3; // 1 GiB nominal total for an unlimited mailbox's pseudo-usage bar.

/** A stable pseudo-random fraction in `[0.05, 0.95)` derived from `input` — same input always yields the same output (`getMailboxUsage`'s doc comment). Not a cryptographic hash; this only ever feeds fixture display data. */
function stableFraction(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return 0.05 + (hash % 900) / 1000;
}

export class FakeDmsDriver implements DmsDriver {
  private accounts: PostfixAccountEntry[];
  private aliases: PostfixVirtualEntry[];
  private quotas: DovecotQuotaEntry[];
  private sendAccess: PostfixAccessEntry[];
  private receiveAccess: PostfixAccessEntry[];
  /** Keyed by lowercased domain — models `setup config dkim`'s file-per-domain output (★7) well enough for `getDkimRecord` to have something real to read back after `generateDkim`. */
  private dkimKeys = new Map<string, FakeDkimKeyState>();
  /** Mutated by `fail2banBan`/`fail2banUnban` so `fail2banList` reflects real prior calls rather than always returning the same static fixture. */
  private bannedIps = new Set<string>();
  /** Keyed by Dovecot user (email), then script name — mirrors `doveadm sieve`'s own "many stored scripts, at most one active" model (`sieve-list-parser.ts`) entirely in memory. */
  private sieveScripts = new Map<string, Map<string, { content: string; active: boolean }>>();

  constructor() {
    // Seeded once, at construction, by parsing the same fixture file
    // content a real DMS install would have written — so the fake starts
    // from state that has actually round-tripped through the real parsers
    // at least once, rather than a hand-built object graph that could
    // drift from what the parsers actually produce.
    this.accounts = [...parsePostfixAccounts(FIXTURE_POSTFIX_ACCOUNTS_CF).entries];
    this.aliases = [...parsePostfixVirtual(FIXTURE_POSTFIX_VIRTUAL_CF).entries];
    this.quotas = [...parseDovecotQuotas(FIXTURE_DOVECOT_QUOTAS_CF).entries];
    this.sendAccess = [...parsePostfixAccess(FIXTURE_POSTFIX_SEND_ACCESS_CF).entries];
    this.receiveAccess = [...parsePostfixAccess(FIXTURE_POSTFIX_RECEIVE_ACCESS_CF).entries];
  }

  /** Selects the in-memory array `getRestrictedAddresses`/`restrictMailbox` operate on for a given scope — mirrors `RealDmsDriver`'s `RESTRICT_SCOPE_FILE_NAME`. */
  private accessListFor(scope: RestrictScope): PostfixAccessEntry[] {
    return scope === 'send' ? this.sendAccess : this.receiveAccess;
  }

  async listMailboxes(): Promise<ParseResult<PostfixAccountEntry>> {
    return { entries: [...this.accounts], issues: [] };
  }

  async listAliases(): Promise<ParseResult<PostfixVirtualEntry>> {
    return { entries: [...this.aliases], issues: [] };
  }

  async listQuotas(): Promise<ParseResult<DovecotQuotaEntry>> {
    return { entries: [...this.quotas], issues: [] };
  }

  async listDomains(): Promise<readonly DerivedDomain[]> {
    return deriveDomains(this.accounts, this.aliases);
  }

  async getCapabilities(): Promise<DmsCapabilities> {
    return detectCapabilities(FIXTURE_DMS_ENV);
  }

  async getRestrictedAddresses(scope: RestrictScope): Promise<ParseResult<PostfixAccessEntry>> {
    return { entries: [...this.accessListFor(scope)], issues: [] };
  }

  /**
   * Deterministic, fixture-only pseudo-usage — never real telemetry. The
   * fake has no Maildir to measure, so it derives a stable percentage from
   * the email string itself (same input always yields the same output,
   * which is what makes it usable in a snapshot-style dev screenshot or a
   * test asserting the *shape* of a usage response) and scales it against
   * the mailbox's configured quota when one exists, or a fixed nominal
   * total otherwise.
   */
  async getMailboxUsage(email: string): Promise<QuotaUsageResult> {
    const quotaEntry = this.quotas.find((quota) => quota.email === email);
    const limitBytes = quotaEntry ? parseQuotaToBytes(quotaEntry.quota) : null;
    const totalForPseudoUsage = limitBytes ?? DEFAULT_FIXTURE_QUOTA_BYTES;
    const usedFraction = stableFraction(email);

    return {
      ok: true,
      usage: {
        storageBytesUsed: Math.round(totalForPseudoUsage * usedFraction),
        storageBytesLimit: limitBytes,
        messageCountUsed: Math.round(50 + usedFraction * 950),
        messageCountLimit: null,
      },
    };
  }

  async addMailbox(params: AddMailboxParams): Promise<void> {
    assertValid(DmsEmailAddRequestSchema, { operation: 'dms.email.add', ...params });
    if (this.accounts.some((account) => account.email === params.email)) {
      throw new DmsCommandValidationError(`An account already exists for ${params.email}.`);
    }
    const split = splitForFixture(params.email);
    this.accounts = [
      ...this.accounts,
      {
        email: params.email,
        localPart: split.localPart,
        domain: split.domain,
        passwordHash: FAKE_PASSWORD_HASH_MARKER,
        attributes: '',
      },
    ];
  }

  async updateMailboxPassword(params: UpdateMailboxPasswordParams): Promise<void> {
    assertValid(DmsEmailUpdateRequestSchema, { operation: 'dms.email.update', ...params });
    if (!this.accounts.some((account) => account.email === params.email)) {
      throw new DmsCommandValidationError(`No account exists for ${params.email}.`);
    }
    this.accounts = this.accounts.map((account) =>
      account.email === params.email
        ? { ...account, passwordHash: FAKE_PASSWORD_HASH_MARKER }
        : account,
    );
  }

  async deleteMailbox(params: DeleteMailboxParams): Promise<void> {
    assertValid(DmsEmailDeleteRequestSchema, { operation: 'dms.email.del', ...params });
    for (const email of params.emails) {
      if (!this.accounts.some((account) => account.email === email)) {
        throw new DmsCommandValidationError(`No account exists for ${email}.`);
      }
    }

    // ★4: unconditionally, regardless of -y/-n — the account entry, its
    // quota entry, and any aliases pointing at it are removed. Only the
    // raw Maildir (which this in-memory fake never models at all) is
    // gated by the flag.
    const deletedEmails = new Set(params.emails);
    this.accounts = this.accounts.filter((account) => !deletedEmails.has(account.email));
    this.quotas = this.quotas.filter((quota) => !deletedEmails.has(quota.email));
    this.aliases = this.aliases
      .map((alias) => ({
        ...alias,
        recipients: alias.recipients.filter((recipient) => !deletedEmails.has(recipient)),
      }))
      .filter((alias) => alias.recipients.length > 0);
  }

  async restrictMailbox(params: RestrictMailboxParams): Promise<void> {
    assertValid(DmsEmailRestrictRequestSchema, { operation: 'dms.email.restrict', ...params });
    // 'list' is a read, satisfied by getRestrictedAddresses instead — see
    // that method and mailboxes.service.ts, which never calls this method
    // with action: 'list'. Kept as a no-op branch here (rather than
    // rejecting it) because commands.ts's own builder already accepts it;
    // this method's contract is "validate and apply", not "re-narrow".
    if (params.action === 'list' || params.email === undefined) return;

    const email = params.email;
    const list = this.accessListFor(params.scope);
    const alreadyPresent = list.some(
      (entry) => entry.email === email && isRestrictAction(entry.action),
    );

    if (params.action === 'add' && !alreadyPresent) {
      const split = splitForFixture(email);
      list.push({ email, localPart: split.localPart, domain: split.domain, action: 'REJECT' });
    } else if (params.action === 'del') {
      const filtered = list.filter((entry) => entry.email !== email);
      list.length = 0;
      list.push(...filtered);
    }
  }

  async setQuota(params: SetQuotaParams): Promise<void> {
    assertValid(DmsQuotaSetRequestSchema, { operation: 'dms.quota.set', ...params });
    if (this.quotas.some((quota) => quota.email === params.email)) {
      this.quotas = this.quotas.map((quota) =>
        quota.email === params.email ? { ...quota, quota: params.quota } : quota,
      );
      return;
    }
    const split = splitForFixture(params.email);
    this.quotas = [
      ...this.quotas,
      {
        email: params.email,
        localPart: split.localPart,
        domain: split.domain,
        quota: params.quota,
      },
    ];
  }

  async deleteQuota(params: DeleteQuotaParams): Promise<void> {
    assertValid(DmsQuotaDeleteRequestSchema, { operation: 'dms.quota.del', ...params });
    this.quotas = this.quotas.filter((quota) => quota.email !== params.email);
  }

  async addAlias(params: AddAliasParams): Promise<void> {
    assertValid(DmsAliasAddRequestSchema, { operation: 'dms.alias.add', ...params });
    const existing = this.aliases.find((alias) => alias.address === params.alias);
    if (existing) {
      if (!existing.recipients.includes(params.recipient)) {
        this.aliases = this.aliases.map((alias) =>
          alias.address === params.alias
            ? { ...alias, recipients: [...alias.recipients, params.recipient] }
            : alias,
        );
      }
      return;
    }
    const split = splitAliasForFixture(params.alias);
    this.aliases = [
      ...this.aliases,
      {
        address: params.alias,
        isCatchAll: params.alias.startsWith('@'),
        localPart: split.localPart,
        domain: split.domain,
        recipients: [params.recipient],
      },
    ];
  }

  async deleteAlias(params: DeleteAliasParams): Promise<void> {
    assertValid(DmsAliasDeleteRequestSchema, { operation: 'dms.alias.del', ...params });
    const existing = this.aliases.find((alias) => alias.address === params.alias);
    if (!existing || !existing.recipients.includes(params.recipient)) {
      throw new DmsCommandValidationError(
        `No alias "${params.alias}" with recipient "${params.recipient}" exists.`,
      );
    }
    // ★2: removes one recipient, or the whole alias if it was the last one.
    this.aliases = this.aliases
      .map((alias) =>
        alias.address === params.alias
          ? {
              ...alias,
              recipients: alias.recipients.filter((recipient) => recipient !== params.recipient),
            }
          : alias,
      )
      .filter((alias) => alias.recipients.length > 0);
  }

  async generateDkim(params: ConfigDkimParams = {}): Promise<void> {
    assertValid(DmsDkimGenerateRequestSchema, { operation: 'dms.dkim.generate', ...params });
    const selector = params.selector ?? DEFAULT_DKIM_SELECTOR;
    const keysize = params.keysize ?? DEFAULT_DKIM_KEYSIZE;
    // ★7: when `domains` is omitted, real DMS auto-sources every mail
    // account domain under ACCOUNT_PROVISIONER=FILE — mirrored here so a
    // no-argument `generateDkim()` call (the common case) still produces
    // something `getDkimRecord` can read back for every domain that
    // actually exists in this fake's fixture data.
    const domains = params.domains ?? [...new Set(this.accounts.map((account) => account.domain))];
    for (const domain of domains) {
      this.dkimKeys.set(domain.toLowerCase(), { selector, keysize });
    }
  }

  async getDkimRecord(domain: string, selector: string): Promise<DkimRecordReadResult> {
    const state = this.dkimKeys.get(domain.toLowerCase());
    if (!state || state.selector !== selector) {
      return { ok: false, reason: 'not-generated' };
    }
    const fakeKeyBody = `${FAKE_DKIM_PUBLIC_KEY_MARKER}${stableHex(`${domain}:${selector}:${state.keysize}`, 48)}`;
    return {
      ok: true,
      record: {
        name: `${selector}._domainkey.${domain}`,
        value: `v=DKIM1; h=sha256; k=rsa; p=${fakeKeyBody}`,
      },
    };
  }

  async getSslType(): Promise<string | null> {
    const raw = FIXTURE_DMS_ENV['SSL_TYPE'];
    return raw === undefined || raw.trim().length === 0 ? null : raw.trim();
  }

  async fail2banBan(params: Fail2banIpParams): Promise<void> {
    assertValid(DmsFail2banBanRequestSchema, { operation: 'dms.fail2ban.ban', ...params });
    this.bannedIps.add(params.ip);
  }

  async fail2banUnban(params: Fail2banIpParams): Promise<void> {
    assertValid(DmsFail2banUnbanRequestSchema, { operation: 'dms.fail2ban.unban', ...params });
    this.bannedIps.delete(params.ip);
  }

  async fail2banList(): Promise<Fail2banListResult> {
    const sorted = [...this.bannedIps].sort();
    return {
      bannedIps: sorted,
      raw:
        sorted.length === 0
          ? 'No IPs are currently banned.'
          : sorted.map((ip) => `Banned: ${ip}`).join('\n'),
    };
  }

  async fail2banStatus(): Promise<string> {
    const sorted = [...this.bannedIps].sort();
    return [
      'Status',
      '|- Number of jail:\t2',
      '`- Jail list:\tdovecot, postfix',
      '',
      'Status for the jail: dovecot',
      `|- Currently banned:\t${sorted.length}`,
      `\`- Banned IP list:\t${sorted.join(' ')}`,
    ].join('\n');
  }

  async clamavPing(): Promise<ClamavReadResult> {
    return { ok: true, output: 'PONG' };
  }

  async clamavVersion(): Promise<ClamavReadResult> {
    return { ok: true, output: FIXTURE_CLAMAV_VERSION };
  }

  async clamavStats(): Promise<ClamavReadResult> {
    return { ok: true, output: FIXTURE_CLAMAV_STATS };
  }

  async clamavLogTail(): Promise<ClamavReadResult> {
    return { ok: true, output: FIXTURE_CLAMAV_LOG };
  }

  async clamavUpdateSignatures(): Promise<string> {
    return 'ClamAV update process started at ...\ndaily.cvd database is up-to-date (version: 27000, sigs: 2000000)';
  }

  /** Every write below validates through the *same* `commands.ts` builder the real driver uses (this class's own doc comment) before touching `sieveScripts`, so an invalid user/name/oversized-by-argv-shape call is rejected identically by both implementations. */
  private scriptsFor(user: string): Map<string, { content: string; active: boolean }> {
    let scripts = this.sieveScripts.get(user);
    if (!scripts) {
      scripts = new Map();
      this.sieveScripts.set(user, scripts);
    }
    return scripts;
  }

  async sieveList(user: string): Promise<readonly SieveScriptSummary[]> {
    assertValid(DmsSieveListRequestSchema, { operation: 'dms.sieve.list', user });
    const scripts = this.sieveScripts.get(user);
    if (!scripts) return [];
    return [...scripts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, state]) => ({ name, active: state.active }));
  }

  async sieveGet(user: string, name: string): Promise<string> {
    assertValid(DmsSieveGetRequestSchema, { operation: 'dms.sieve.get', user, script: name });
    const script = this.sieveScripts.get(user)?.get(name);
    if (!script) {
      throw new DmsCommandExecutionError(
        ['doveadm', 'sieve', 'get', '-u', user, name],
        1,
        `sieve: user=${user}: Sieve script not found: ${name}`,
      );
    }
    return script.content;
  }

  async sievePut(params: SievePutParams): Promise<void> {
    assertValid(DmsSievePutRequestSchema, { operation: 'dms.sieve.put', ...params });
    const scripts = this.scriptsFor(params.user);
    const existing = scripts.get(params.script);
    scripts.set(params.script, { content: params.content, active: existing?.active ?? false });
  }

  async sieveActivate(params: SieveScriptParams): Promise<void> {
    assertValid(DmsSieveActivateRequestSchema, { operation: 'dms.sieve.activate', ...params });
    const scripts = this.sieveScripts.get(params.user);
    const target = scripts?.get(params.script);
    if (!scripts || !target) {
      throw new DmsCommandExecutionError(
        ['doveadm', 'sieve', 'activate', '-u', params.user, params.script],
        1,
        `sieve: user=${params.user}: Sieve script not found: ${params.script}`,
      );
    }
    // Only one script is ever active per user, matching real Pigeonhole
    // semantics (`sieve-list-parser.ts`'s own doc comment) — deactivate
    // every other stored script before activating the target one.
    for (const [name, state] of scripts) {
      scripts.set(name, { ...state, active: name === params.script });
    }
  }

  async sieveDeactivate(params: SieveUserParams): Promise<void> {
    assertValid(DmsSieveDeactivateRequestSchema, { operation: 'dms.sieve.deactivate', ...params });
    const scripts = this.sieveScripts.get(params.user);
    if (!scripts) return;
    for (const [name, state] of scripts) {
      scripts.set(name, { ...state, active: false });
    }
  }

  /** Static fixture, parsed fresh each call — same "no real backing store to mutate" shape as `volumeRemove` on `FakeBrokerClient` (nothing here ever enqueues or delivers a message). */
  async getMailQueue(): Promise<ParseResult<MailQueueEntry>> {
    return parsePostqueueJson(FIXTURE_POSTQUEUE_JSON);
  }
}
