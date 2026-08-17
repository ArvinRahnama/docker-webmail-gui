/**
 * `RspamdClientPort` — the entire Rspamd controller surface this project
 * uses, mirroring `DnsLookupPort`/`DmsExecPort`'s port pattern:
 * real logic depends on this interface, not a concrete HTTP client, so
 * it is unit-testable against a fixture fake with no live controller
 * (IMPLEMENTATION_PLAN.md §2.4).
 *
 * **Every method here is a named operation with a hardcoded endpoint
 * path and method** — there is no generic `request(path, method, body)`
 * escape hatch, on purpose. That is not an implementation-style
 * preference; it is the structural half of SECURITY.md §3.13's refusal:
 * a caller holding a `RspamdClientPort` cannot express a call to any
 * Rspamd endpoint this interface does not already name, which makes
 * "no general Rspamd configuration editor" true by construction rather
 * than by every call site remembering not to add one.
 *
 * Read methods return the endpoint's **raw JSON body**, not a parsed
 * shape — `docs/research/03-mail-stack-components.md` §1 flags `/stat`'s
 * (and `/symbols`'/`/actions`') exact field names as `[INFERRED]`, never
 * independently confirmed against a live controller in this environment.
 * Parsing that defensively is `parse-stat.ts`/`parse-symbols.ts`/
 * `parse-actions.ts`'s job, kept separate so the HTTP layer never needs
 * to change shape assumptions.
 */

export type RspamdResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface RspamdClientPort {
  /** `GET /stat` — scan/learn counters. */
  getStat(): Promise<RspamdResult<unknown>>;
  /** `GET /symbols` — loaded rule symbols, weights, descriptions, groups. */
  getSymbols(): Promise<RspamdResult<unknown>>;
  /** `GET /actions` — current score thresholds per action. */
  getActions(): Promise<RspamdResult<unknown>>;
  /** `POST /learnspam` — trains Bayes as spam. Body is the raw message. Mutating, privileged (FEATURE_MATRIX.md §15). */
  learnSpam(message: string): Promise<RspamdResult<void>>;
  /** `POST /learnham` — trains Bayes as ham. Same shape as `learnSpam`. */
  learnHam(message: string): Promise<RspamdResult<void>>;
  /**
   * `POST /saveactions` for exactly one action/score pair — the allowlisted
   * write FEATURE_MATRIX.md §15 permits, never a full actions document.
   */
  saveActionThreshold(action: string, score: number): Promise<RspamdResult<void>>;
  /** `POST /savesymbols` for exactly one symbol/score pair — same allowlist discipline as `saveActionThreshold`. */
  saveSymbolScore(symbol: string, score: number): Promise<RspamdResult<void>>;
}
