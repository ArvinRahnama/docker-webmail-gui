/**
 * Parses `doveadm -f json quota get -u <email>` — the live usage half of
 * FEATURE_MATRIX.md §7 ("Usage | Full | `doveadm quota get`"), distinct
 * from `parsers/dovecot-quotas.ts`, which only reads the configured
 * *limit* out of `dovecot-quotas.cf`. `-f json` is a real, documented
 * `doveadm` formatter — confirmed against two upstream man pages
 * (`docs/research/03-mail-stack-components.md` §6: "This is real and
 * verified against two separate man pages — safe to build UI parsing
 * around `-f json` output") — so this is a genuine capability, not an
 * invented one, and belongs alongside `domains.ts`/`capabilities.ts` as a
 * top-level driver concern rather than under `parsers/` (which is
 * reserved for the three `.cf` config-file formats).
 *
 * **Deliberately defensive**, for the same reason `capabilities.ts` and
 * this project's own DNS/Rspamd code treat an unconfirmed shape as
 * `Unknown` rather than a guess: the research base confirms *that*
 * `doveadm quota get` reports one row per quota resource with
 * `type`/`value`/`limit`-shaped columns (`STORAGE`, `MESSAGE`), but does
 * not pin down the exact JSON key casing, nor whether `STORAGE`'s
 * `value`/`limit` are bytes or kibibytes — no live docker-mailserver
 * container exists in this environment to confirm either
 * (ARCHITECTURE.md §9). This parser therefore accepts a handful of
 * plausible key spellings and, if it cannot confidently find a `STORAGE`
 * row, returns `{ ok: false }` — rendered as `Unknown` by the UI, never a
 * fabricated number (UX_ARCHITECTURE.md §2 principle 2). The
 * KiB-to-bytes conversion below follows Dovecot's long-documented
 * convention for the `STORAGE` resource; this specific point is flagged
 * in FEATURE_MATRIX.md's "Deferred to runtime verification" table for
 * confirmation against a real deployment, exactly like that table's
 * existing Rspamd/ClamAV entries.
 */

export interface QuotaUsage {
  readonly storageBytesUsed: number;
  /** `null` when unlimited (no limit row, or a reported limit of 0 — Dovecot's own convention for "no limit"). */
  readonly storageBytesLimit: number | null;
  readonly messageCountUsed: number | null;
  readonly messageCountLimit: number | null;
}

export type QuotaUsageResult =
  | { readonly ok: true; readonly usage: QuotaUsage }
  | { readonly ok: false; readonly reason: string };

const STORAGE_UNIT_BYTES = 1024; // doveadm reports STORAGE in KiB; see the module comment.

const QUOTA_VALUE_UNIT_MULTIPLIER: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/**
 * Converts a `dovecot-quotas.cf`-style configured-limit value (e.g.
 * `"2G"`, matching `validators.ts`'s `QUOTA_PATTERN`) to bytes. Shared by
 * `FakeDmsDriver.getMailboxUsage`'s pseudo-usage math and
 * `modules/mail/mailboxes.service.ts`'s numeric "sort by quota" —
 * comparing the *strings* lexically would rank `"500M"` before `"50M"`,
 * which is backwards. Returns `null` for anything not matching the
 * expected shape (defensive, not re-validating — the value has usually
 * already round-tripped through `parseDovecotQuotas`).
 */
export function parseQuotaToBytes(quota: string): number | null {
  const match = /^([0-9]+)([bBkKmMgGtT]?)$/.exec(quota);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] as string).toLowerCase();
  const multiplier = QUOTA_VALUE_UNIT_MULTIPLIER[unit];
  return multiplier === undefined ? null : amount * multiplier;
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

const TYPE_KEYS = ['type', 'Type', 'TYPE'] as const;
const VALUE_KEYS = ['value', 'Value', 'VALUE', 'current', 'Current'] as const;
const LIMIT_KEYS = ['limit', 'Limit', 'LIMIT'] as const;

/**
 * Parses one `doveadm -f json quota get -u <email>` invocation's stdout.
 * Never throws — malformed/unexpected JSON is reported via the `ok: false`
 * branch, matching every other parser in this driver
 * (`parsers/parse-result.ts`'s doc comment: "never throws, regardless of
 * input").
 */
export function parseDoveadmQuotaGet(jsonText: string): QuotaUsageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'doveadm quota get output was not valid JSON' };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'doveadm quota get output was not a JSON array' };
  }

  let storageUsed: number | null = null;
  let storageLimit: number | null = null;
  let messageUsed: number | null = null;
  let messageLimit: number | null = null;

  for (const rawRow of parsed) {
    const row = asRecord(rawRow);
    if (!row) continue;

    const type = readString(row, TYPE_KEYS)?.toUpperCase();
    if (type === 'STORAGE') {
      storageUsed = readNumber(row, VALUE_KEYS);
      storageLimit = readNumber(row, LIMIT_KEYS);
    } else if (type === 'MESSAGE') {
      messageUsed = readNumber(row, VALUE_KEYS);
      messageLimit = readNumber(row, LIMIT_KEYS);
    }
  }

  if (storageUsed === null) {
    return {
      ok: false,
      reason: 'no recognisable STORAGE row found in doveadm quota get output',
    };
  }

  return {
    ok: true,
    usage: {
      storageBytesUsed: storageUsed * STORAGE_UNIT_BYTES,
      storageBytesLimit:
        storageLimit !== null && storageLimit > 0 ? storageLimit * STORAGE_UNIT_BYTES : null,
      messageCountUsed: messageUsed,
      messageCountLimit: messageLimit !== null && messageLimit > 0 ? messageLimit : null,
    },
  };
}
