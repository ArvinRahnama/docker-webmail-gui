/**
 * Defensive parser for `doveadm -f json sieve list -u <user>` (research
 * doc §6: "doveadm supports a global `-f FORMATTER` flag with
 * formatters... `json` (JSON array of objects)... safe to build UI parsing
 * around `-f json` output" — confirmed against two man pages at the
 * *formatter* level). What is `[UNCERTAIN]` is `sieve list`'s own exact
 * JSON key names and how it marks the active script, since no live sample
 * was available this session — so, mirroring `fail2ban-parser.ts` and
 * `quota-usage.ts`'s own handling of an unconfirmed shape, this accepts
 * several plausible key spellings for the JSON path and falls back to a
 * plain-text, one-name-per-line reading (matching `doveadm`'s default
 * `table` formatter) if the output is not JSON at all. Either path
 * recognises a trailing `(active)`/`[ACTIVE]`/`ACTIVE` marker as the
 * "which script actually runs at delivery" signal. Never throws.
 */

export interface SieveScriptSummary {
  readonly name: string;
  readonly active: boolean;
}

// The leading `[\s([]+` requires *at least one* separator character before
// "active" — deliberately not `*` (zero-or-more). A `*` would also match a
// script legitimately *named* something ending in "active" (e.g.
// "proactive-filter") with nothing separating it from the marker, silently
// truncating a real name. Requiring a real separator means only a clearly
// delimited marker ("name (active)", "name ACTIVE", "name [active]") is
// ever recognised.
const ACTIVE_MARKER_PATTERN = /[\s([]+active[\s)\]]*$/i;

/** Strips a trailing active marker (`"name (active)"`, `"name [ACTIVE]"`, `"name ACTIVE"`) off a plain-text listing entry, reporting whether one was found. */
function stripActiveMarker(raw: string): SieveScriptSummary {
  const active = ACTIVE_MARKER_PATTERN.test(raw);
  const name = active ? raw.replace(ACTIVE_MARKER_PATTERN, '').trim() : raw.trim();
  return { name, active };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readBoolean(row: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true' || lowered === 'yes' || lowered === 'active') return true;
    }
    if (typeof value === 'number') return value !== 0;
  }
  return false;
}

const NAME_KEYS = ['name', 'script', 'scriptname', 'sieve'] as const;
const ACTIVE_KEYS = ['active', 'is_active', 'isActive'] as const;

function parseJsonEntry(entry: unknown): SieveScriptSummary | null {
  if (typeof entry === 'string') {
    return entry.trim().length > 0 ? stripActiveMarker(entry) : null;
  }
  const row = asRecord(entry);
  if (!row) return null;
  const name = readString(row, NAME_KEYS);
  if (!name) return null;
  return { name, active: readBoolean(row, ACTIVE_KEYS) };
}

function parseTextLines(text: string): readonly SieveScriptSummary[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => stripActiveMarker(line));
}

export function parseSieveList(stdout: string): readonly SieveScriptSummary[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const entries = parsed
          .map((entry) => parseJsonEntry(entry))
          .filter((entry): entry is SieveScriptSummary => entry !== null);
        return entries;
      }
    } catch {
      // Not actually JSON despite the leading "[" — fall through to the
      // plain-text reading below rather than reporting a hard failure.
    }
  }

  return parseTextLines(trimmed);
}
