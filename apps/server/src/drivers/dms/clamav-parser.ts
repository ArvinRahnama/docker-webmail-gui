/**
 * Defensive parsing for ClamAV/clamd output (FEATURE_MATRIX.md §16;
 * `docs/research/03-mail-stack-components.md` §2).
 *
 * `VERSION`'s reply format (`ClamAV <engine>/<sigVersion>/<sigDate>`) is
 * itself only `[INFERRED]` — "well-established, exact string not
 * independently verified this session" per the research doc — so
 * {@link parseClamdVersion} degrades to an all-`null` structured result
 * (never a guess) while always preserving `raw` for verbatim display, the
 * same discipline `fail2ban-parser.ts` and `quota-usage.ts` already use for
 * their own `[UNCERTAIN]`/`[INFERRED]` upstream shapes.
 *
 * `STATS` is explicitly documented upstream as unstable free text
 * (`docs.clamav.net`), so this module makes no attempt to parse it at
 * all — it is carried verbatim end to end (driver → service → schema →
 * UI), taking FEATURE_MATRIX.md §16's `STATS` row ("parsed defensively
 * and shown raw if parsing fails") to its logical conclusion: for a format
 * with no documented schema, the only honest thing to parse it *into* is
 * itself.
 *
 * {@link countClamavDetections} is the "detection counts... log parsing
 * only" half of FEATURE_MATRIX.md §16. clamd exposes no counter for this
 * (research doc §2's ★2), and there is no confirmed sample of a real
 * docker-mailserver ClamAV log line either — so rather than committing to
 * one exact line shape that could silently match zero real lines on a
 * format drift, this counts any log line that plausibly names both a
 * ClamAV-attributed source *and* a positive scan verdict, mirroring
 * `fail2ban-parser.ts`'s own "extract a real signal defensively rather
 * than assume a table layout" approach. `FOUND` as the terminal token of a
 * positive ClamAV scan result (`clamscan`/`clamd`/`clamdscan` alike) is a
 * long-stable, well-documented convention independent of this specific
 * pass's research; pairing it with a ClamAV/virus-attribution token
 * avoids counting an unrelated log line that happens to contain the word
 * "found".
 */

export interface ClamdVersionInfo {
  /** The reply exactly as clamd sent it, whitespace-trimmed — always shown verbatim regardless of whether the fields below could be split out. */
  readonly raw: string;
  readonly engineVersion: string | null;
  readonly signatureVersion: string | null;
  readonly signatureDate: string | null;
}

/**
 * Splits a `VERSION` reply of the documented shape
 * `ClamAV <engine>/<sigVersion>/<sigDate>` into its three parts. Any reply
 * that does not contain at least two `/` separators is reported with all
 * three fields `null` — never a mis-split guess — while `raw` still carries
 * the full text for the UI to fall back to.
 */
export function parseClamdVersion(reply: string): ClamdVersionInfo {
  const raw = reply.trim();
  const firstSlash = raw.indexOf('/');
  const secondSlash = raw.indexOf('/', firstSlash + 1);
  if (firstSlash === -1 || secondSlash === -1) {
    return { raw, engineVersion: null, signatureVersion: null, signatureDate: null };
  }
  const engineVersion = raw.slice(0, firstSlash).trim();
  const signatureVersion = raw.slice(firstSlash + 1, secondSlash).trim();
  const signatureDate = raw.slice(secondSlash + 1).trim();
  return {
    raw,
    engineVersion: engineVersion.length > 0 ? engineVersion : null,
    signatureVersion: signatureVersion.length > 0 ? signatureVersion : null,
    signatureDate: signatureDate.length > 0 ? signatureDate : null,
  };
}

/** Healthy clamd's documented `PING` reply — checked case-insensitively since the exact casing of a wire reply is not itself load-bearing. */
export function isPongReply(reply: string): boolean {
  return reply.trim().toUpperCase() === 'PONG';
}

const CLAMAV_ATTRIBUTION_PATTERN = /clam|virus/i;
const POSITIVE_VERDICT_PATTERN = /\bfound\b/i;

/**
 * Counts log lines that plausibly record a ClamAV virus detection — see
 * the module comment for why this is a defensive token match rather than a
 * committed line format. Never throws; an empty or unrelated log simply
 * counts zero, which is the honest answer, not an error.
 */
export function countClamavDetections(logText: string): number {
  let count = 0;
  for (const line of logText.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (CLAMAV_ATTRIBUTION_PATTERN.test(line) && POSITIVE_VERDICT_PATTERN.test(line)) {
      count += 1;
    }
  }
  return count;
}
