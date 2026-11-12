/**
 * `GET /history` — Rspamd's recent-scan log. Version 2 (Rspamd 3.x/4.x,
 * confirmed against Rspamd 4.1.5 in docker-mailserver 16) is
 * `{ version: 2, rows: [...] }`; older releases returned the bare array.
 * Bound defensively like every other Rspamd parser here: a row missing a
 * field is kept with that field `null`, a row that is not an object is
 * skipped, and nothing is invented.
 */

export interface RspamdHistoryRow {
  readonly unixTime: number;
  readonly action: string;
  readonly score: number | null;
  readonly subject: string | null;
  readonly sender: string | null;
  readonly recipients: readonly string[];
  readonly ip: string | null;
  readonly messageId: string | null;
  readonly symbols: readonly string[];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function parseRspamdHistory(raw: unknown): RspamdHistoryRow[] {
  const rows: unknown = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object'
      ? (raw as { rows?: unknown }).rows
      : null;
  if (!Array.isArray(rows)) return [];

  const parsed: RspamdHistoryRow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const unixTime = typeof r['unix_time'] === 'number' ? r['unix_time'] : null;
    const action = str(r['action']);
    if (unixTime === null || action === null) continue;
    const symbols = r['symbols'];
    parsed.push({
      unixTime,
      action,
      score: typeof r['score'] === 'number' && Number.isFinite(r['score']) ? r['score'] : null,
      subject: str(r['subject']),
      sender: str(r['sender_smtp']) ?? str(r['sender_mime']),
      recipients:
        strings(r['rcpt_smtp']).length > 0 ? strings(r['rcpt_smtp']) : strings(r['rcpt_mime']),
      ip: str(r['ip']),
      messageId: str(r['message-id']),
      symbols: Array.isArray(symbols)
        ? strings(symbols)
        : symbols !== null && typeof symbols === 'object'
          ? Object.keys(symbols)
          : [],
    });
  }
  return parsed;
}
