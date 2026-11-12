/**
 * "What mail was rejected, and why" — every SMTP-time refusal the mail
 * server made that is still within reach:
 *
 *  - Postfix's own reject lines in the mail log: unknown recipients, bad
 *    sender domains, blocklisted clients, and every milter verdict (Rspamd,
 *    including ClamAV). Read through the broker's `logs.file`.
 *  - Rspamd's `/history` rows whose action was a reject. These carry the
 *    subject and score the log line lacks; a milter reject present in both
 *    is merged into one entry rather than listed twice.
 *
 * Neither source is a complete history — the log tail is bounded and
 * rotates, and Rspamd keeps a few hundred rows — so the response always
 * says how far back it reaches.
 */
import { LOGS_TAIL_MAX, type RejectedMailEntry, type RejectedMailResponse } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/index.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { categoriseRejection, parseRejectLines } from '../../drivers/dms/maillog-parser.js';
import { parseRspamdHistory, type RspamdClientPort } from '../../drivers/rspamd/index.js';
import type { RspamdHistoryRow } from '../../drivers/rspamd/parse-history.js';

const WINDOW = `the most recent ${LOGS_TAIL_MAX.toLocaleString('en-US')} lines of the mail log (older entries are lost once it rotates), plus Rspamd's own recent-scan history`;
/** A milter reject is logged by Postfix within moments of Rspamd scanning it. */
const MERGE_WINDOW_MS = 10_000;
const MAX_ENTRIES = 500;

function isRejectAction(action: string): boolean {
  return action === 'reject' || action === 'soft reject';
}

function fromRspamd(row: RspamdHistoryRow): RejectedMailEntry {
  const virus = row.symbols.some((s) => s.startsWith('CLAM_VIRUS') || s.includes('VIRUS'));
  const reason = virus
    ? `Virus found (${row.symbols.filter((s) => s.includes('VIRUS')).join(', ')})`
    : `Rspamd ${row.action}${row.score === null ? '' : ` at score ${row.score.toFixed(2)}`}`;
  return {
    at: new Date(row.unixTime * 1000).toISOString(),
    source: 'rspamd',
    category: virus ? 'virus' : categoriseRejection(reason, true),
    temporary: row.action === 'soft reject',
    clientIp: row.ip,
    clientHost: null,
    from: row.sender,
    to: [...row.recipients],
    subject: row.subject,
    score: row.score,
    smtpCode: null,
    reason,
  };
}

function sameMessage(entry: RejectedMailEntry, row: RspamdHistoryRow): boolean {
  if (Math.abs(Date.parse(entry.at) - row.unixTime * 1000) > MERGE_WINDOW_MS) return false;
  if ((entry.from ?? '').toLowerCase() !== (row.sender ?? '').toLowerCase()) return false;
  const recipients = new Set(row.recipients.map((r) => r.toLowerCase()));
  return entry.to.length === 0 || entry.to.some((r) => recipients.has(r.toLowerCase()));
}

/** Merges Rspamd rows into matching milter rejects (adding subject and score) and keeps the rest as their own entries. Exported for tests. */
export function mergeRejections(
  logEntries: readonly RejectedMailEntry[],
  history: readonly RspamdHistoryRow[],
): RejectedMailEntry[] {
  const merged = logEntries.map((e) => ({ ...e, to: [...e.to] }));
  for (const row of history) {
    if (!isRejectAction(row.action)) continue;
    const match = merged.find(
      (e) =>
        e.source === 'postfix' &&
        e.subject === null &&
        (e.category === 'spam' || e.category === 'virus') &&
        sameMessage(e, row),
    );
    if (match !== undefined) {
      match.subject = row.subject;
      match.score = row.score;
      continue;
    }
    merged.push(fromRspamd(row));
  }
  return merged.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ENTRIES);
}

export class RejectedMailService {
  constructor(
    private readonly brokerClient: BrokerClient,
    private readonly rspamdClient: RspamdClientPort,
    private readonly dmsDriver: DmsDriver,
  ) {}

  async list(): Promise<RejectedMailResponse> {
    let logEntries: RejectedMailEntry[] = [];
    let logAvailable = true;
    let logError: string | null = null;
    try {
      logEntries = parseRejectLines(
        await this.brokerClient.logsFile('mail', { tail: LOGS_TAIL_MAX }),
      );
    } catch (err) {
      logAvailable = false;
      logError = err instanceof Error ? err.message : String(err);
    }

    let history: RspamdHistoryRow[] = [];
    let rspamdAvailable = false;
    const capabilities = await this.dmsDriver.getCapabilities().catch(() => null);
    if (capabilities?.rspamd.supported) {
      const result = await this.rspamdClient.getHistory();
      if (result.ok) {
        history = parseRspamdHistory(result.value);
        rspamdAvailable = true;
      }
    }

    return {
      entries: mergeRejections(logEntries, history),
      window: WINDOW,
      logAvailable,
      logError,
      rspamdAvailable,
    };
  }
}
