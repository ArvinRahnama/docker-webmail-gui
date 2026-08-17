/**
 * Defensive parser for `GET /actions` (same `[INFERRED]` caveat as
 * `parse-symbols.ts`). Accepts either an array of `{action, value|score}`
 * objects or a flat `{"reject": 15, "add header": 6, ...}` map — both
 * shapes have been reported for this endpoint across Rspamd versions.
 */
import type { RspamdActionThreshold } from '@dwg/shared';

export type RspamdActionsParseResult =
  | { readonly ok: true; readonly actions: readonly RspamdActionThreshold[] }
  | { readonly ok: false; readonly reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function readNumber(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function parseRspamdActions(raw: unknown): RspamdActionsParseResult {
  if (Array.isArray(raw)) {
    const actions: RspamdActionThreshold[] = [];
    for (const entry of raw) {
      const row = asRecord(entry);
      if (!row) continue;
      const action = readString(row, ['action', 'name']);
      if (action === null) continue;
      actions.push({ action, score: readNumber(row, ['value', 'score']) });
    }
    // Same "empty input vs unrecognised shape" distinction as
    // `parse-symbols.ts`'s array branch.
    if (raw.length === 0 || actions.length > 0) return { ok: true, actions };
  }

  const row = asRecord(raw);
  if (row) {
    const actions: RspamdActionThreshold[] = [];
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        actions.push({ action: key, score: value });
      }
    }
    if (actions.length > 0) return { ok: true, actions };
  }

  return { ok: false, reason: 'Rspamd returned an unrecognised /actions response shape.' };
}
