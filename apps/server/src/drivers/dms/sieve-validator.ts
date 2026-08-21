/**
 * Sieve script **content** validation (FEATURE_MATRIX.md §17: "Scripts are
 * validated server-side and rejected if they reference execute/pipe
 * extensions... Scripts are size-capped and syntax-checked before being
 * stored"). Deliberately separate from `validators.ts`, which validates
 * short argv leaf values (an email, a script *name*) — this validates a
 * whole document's content before it is ever piped to `doveadm sieve put`.
 *
 * **Security-critical, so deliberately simple.** `vnd.dovecot.execute` and
 * `sieve_pipe` are the two extensions FEATURE_MATRIX.md §17 names as able
 * to invoke an
 * external program from inside a script Dovecot runs at mail-delivery
 * time — a real code-execution path if left reachable through an admin
 * panel. Rather than writing (or depending on) a full Sieve parser to
 * understand *semantic* context, this does what `fail2ban-parser.ts` does
 * for its own `[UNCERTAIN]` shape: a defensive, case-insensitive substring
 * match across the raw text. A false positive (the token appearing inside
 * a comment or a string literal) rejects a script that would have been
 * harmless — an acceptable cost for a hard security boundary, and one the
 * admin can trivially work around by rewording a comment. A false
 * negative — a real `execute`/`pipe` invocation slipping through — is the
 * failure mode this module exists to make structurally impossible.
 *
 * Real syntax checking (does this script even compile?) is **not**
 * duplicated here: `doveadm sieve put` runs the script through Pigeonhole's
 * own compiler before installing it, so an actual syntax error is caught
 * for real, by the real implementation, not approximated here — see
 * `sieve.service.ts`.
 */

/** Generous for what a real Sieve filter or vacation script ever needs (a handful of rules/conditions) while still bounding the exec payload and the stored-script table this project keeps no separate copy of. A deliberate project choice, not a documented DMS/Pigeonhole limit. */
export const SIEVE_SCRIPT_MAX_BYTES = 32_768;

const FORBIDDEN_EXTENSION_TOKENS = ['vnd.dovecot.execute', 'sieve_pipe'] as const;

export interface SieveValidationResult {
  readonly ok: boolean;
  /** Present, and safe to show verbatim, only when `ok` is `false`. */
  readonly reason?: string;
}

/**
 * Rejects a script that is empty, oversized, or references either
 * forbidden extension token — never throws. Byte length (not character
 * length) is what is capped, since that is what actually crosses the exec
 * boundary as stdin.
 */
export function validateSieveScriptContent(content: string): SieveValidationResult {
  if (content.trim().length === 0) {
    return { ok: false, reason: 'Script must not be empty.' };
  }

  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > SIEVE_SCRIPT_MAX_BYTES) {
    return {
      ok: false,
      reason: `Script is ${byteLength} bytes, over the ${SIEVE_SCRIPT_MAX_BYTES}-byte limit.`,
    };
  }

  const lowered = content.toLowerCase();
  for (const token of FORBIDDEN_EXTENSION_TOKENS) {
    if (lowered.includes(token)) {
      return {
        ok: false,
        reason: `Script references "${token}", which can invoke an external program and is refused (FEATURE_MATRIX.md §17).`,
      };
    }
  }

  return { ok: true };
}
