/**
 * Defensive parser for `GET /symbols` (`docs/research/03-mail-stack-components.md`
 * §1: method/response-field detail "mostly `[INFERRED]`"). Real-world
 * Rspamd deployments have been observed returning either a flat array of
 * symbol objects, or an object keyed by group name whose values each
 * carry a nested `symbols` collection — this parser accepts both rather
 * than committing to one, and reports `ok: false` (never a silently
 * empty list, which would look identical to "this deployment genuinely
 * has zero symbols") when neither shape is recognised.
 */
import type { RspamdSymbol } from '@dwg/shared';

export type RspamdSymbolsParseResult =
  | { readonly ok: true; readonly symbols: readonly RspamdSymbol[] }
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

function toSymbol(row: Record<string, unknown>, fallbackName: string | null): RspamdSymbol | null {
  const name = readString(row, ['symbol', 'name']) ?? fallbackName;
  const score = readNumber(row, ['score', 'weight']);
  if (name === null || score === null) return null;
  return {
    name,
    score,
    description: readString(row, ['description']),
    group: readString(row, ['group']),
  };
}

export function parseRspamdSymbols(raw: unknown): RspamdSymbolsParseResult {
  if (Array.isArray(raw)) {
    const symbols: RspamdSymbol[] = [];
    for (const entry of raw) {
      const row = asRecord(entry);
      const symbol = row ? toSymbol(row, null) : null;
      if (symbol) symbols.push(symbol);
    }
    // An empty input array is a genuine "zero symbols" answer; a
    // non-empty array from which nothing could be extracted is an
    // unrecognised shape, not an honest empty result — the two must not
    // look the same to a caller.
    if (raw.length === 0 || symbols.length > 0) return { ok: true, symbols };
  }

  const topLevel = asRecord(raw);
  if (topLevel) {
    const symbols: RspamdSymbol[] = [];
    for (const [key, value] of Object.entries(topLevel)) {
      const row = asRecord(value);
      if (!row) continue;

      const nestedSymbols = row['symbols'];
      if (Array.isArray(nestedSymbols)) {
        for (const entry of nestedSymbols) {
          const nestedRow = asRecord(entry);
          const symbol = nestedRow ? toSymbol(nestedRow, null) : null;
          if (symbol) symbols.push(symbol);
        }
        continue;
      }
      const nestedRecord = asRecord(nestedSymbols);
      if (nestedRecord) {
        for (const [symbolName, symbolValue] of Object.entries(nestedRecord)) {
          const symbolRow = asRecord(symbolValue);
          const symbol = symbolRow ? toSymbol(symbolRow, symbolName) : null;
          if (symbol) symbols.push(symbol);
        }
        continue;
      }

      // Not a group wrapper — try treating this entry itself as a
      // symbol, keyed by its own name.
      const symbol = toSymbol(row, key);
      if (symbol) symbols.push(symbol);
    }
    if (symbols.length > 0) return { ok: true, symbols };
  }

  return { ok: false, reason: 'Rspamd returned an unrecognised /symbols response shape.' };
}
