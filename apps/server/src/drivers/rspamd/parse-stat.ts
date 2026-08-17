/**
 * Defensive parser for Rspamd's `GET /stat` response
 * (`docs/research/03-mail-stack-components.md` §1's ★1: the exact field
 * list is `[INFERRED]`, confirmed to exist but not independently
 * verified against a live controller this session). Mirrors
 * `drivers/dms/quota-usage.ts`'s discipline exactly: accept a handful of
 * plausible key spellings, and report a field as `null` — never a
 * fabricated `0` — when it cannot be confidently found. A dashboard/tile
 * reading `null` renders "Unknown"; reading a wrong guessed number would
 * be worse than either.
 */
import type { RspamdStat } from '@dwg/shared';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** `/stat`'s `actions` field, widely reported (not independently confirmed) as an object keyed by action name -> count. Any other shape yields `{}`, never a guess. */
function readActions(row: Record<string, unknown>): Record<string, number> {
  const raw = asRecord(row['actions']);
  if (!raw) return {};
  const actions: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) actions[key] = value;
  }
  return actions;
}

/** Never throws — an unrecognisable body yields every field `null` and `actions: {}`, which is a genuinely honest "we could not read this" rather than a parse failure that would need its own separate error branch. */
export function parseRspamdStat(raw: unknown): RspamdStat {
  const row = asRecord(raw);
  if (!row) {
    return { scanned: null, learned: null, hamCount: null, spamCount: null, actions: {} };
  }

  return {
    scanned: readNumber(row, ['scanned']),
    learned: readNumber(row, ['learned']),
    hamCount: readNumber(row, ['ham_count', 'hamCount']),
    spamCount: readNumber(row, ['spam_count', 'spamCount']),
    actions: readActions(row),
  };
}
