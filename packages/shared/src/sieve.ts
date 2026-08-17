/**
 * Zod schemas for Sieve filter management and the autoresponder (M8 —
 * FEATURE_MATRIX.md §17 Sieve filters, §18 Autoresponder). Mirrors
 * `security.ts`/`antispam.ts`'s shape.
 *
 * **The autoresponder is Sieve** — a `vacation` (RFC 5230) script,
 * wrapped in `currentdate` (RFC 5260) tests for its date window, stored
 * under a reserved script name and generated entirely server-side from
 * {@link UpdateAutoresponderRequestSchema}'s structured fields
 * (`drivers/dms/autoresponder-sieve.ts`). **There is no schema anywhere
 * below that accepts raw Sieve text for the autoresponder** — only the
 * general-purpose Sieve editor (`PutSieveScriptRequestSchema`) ever
 * carries a script body, and that path is rejected server-side if it
 * references `vnd.dovecot.execute`/`sieve_pipe`
 * (`drivers/dms/sieve-validator.ts`).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sieve script management — §17.
// ---------------------------------------------------------------------------

export const SieveScriptSummarySchema = z.object({
  name: z.string(),
  /** At most one script is ever active per mailbox — the one Dovecot actually runs at delivery time. */
  active: z.boolean(),
});
export type SieveScriptSummary = z.infer<typeof SieveScriptSummarySchema>;

export const SieveScriptListResponseSchema = z.object({
  scripts: z.array(SieveScriptSummarySchema),
});
export type SieveScriptListResponse = z.infer<typeof SieveScriptListResponseSchema>;

export const SieveScriptDetailResponseSchema = z.object({
  name: z.string(),
  content: z.string(),
  active: z.boolean(),
});
export type SieveScriptDetailResponse = z.infer<typeof SieveScriptDetailResponseSchema>;

/** `name` is not repeated here — always the `:name` URL parameter, matching `security.ts`'s `GenerateDkimRequestSchema` convention. Upper bound is a generous character-count pre-filter; the authoritative, byte-exact cap is `drivers/dms/sieve-validator.ts`'s `SIEVE_SCRIPT_MAX_BYTES`, enforced server-side regardless of what passes this schema. */
export const PutSieveScriptRequestSchema = z.object({
  content: z.string().min(1).max(100_000),
});
export type PutSieveScriptRequest = z.infer<typeof PutSieveScriptRequestSchema>;

export const SieveWriteResponseSchema = z.object({ ok: z.literal(true) });
export type SieveWriteResponse = z.infer<typeof SieveWriteResponseSchema>;

// ---------------------------------------------------------------------------
// Autoresponder — §18. RFC 5260 `currentdate` wrapping RFC 5230 `vacation`,
// generated server-side; the admin never hand-writes Sieve here.
// ---------------------------------------------------------------------------

const AUTORESPONDER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** RFC 3339 full-date (`YYYY-MM-DD`) — the literal form `currentdate :value "ge"/"le" "date" "..."` compares against. */
export const AutoresponderDateSchema = z
  .string()
  .regex(AUTORESPONDER_DATE_PATTERN, 'must be a date in YYYY-MM-DD form, e.g. "2026-08-20"');

export const AutoresponderStatusSchema = z.object({
  /** Whether the reserved autoresponder script is the mailbox's *active* Sieve script right now — not merely whether one has ever been configured. */
  enabled: z.boolean(),
  subject: z.string().nullable(),
  message: z.string().nullable(),
  /** `null` means "no lower bound" — the responder is active from any time in the past once `enabled`. */
  startDate: z.string().nullable(),
  /** `null` means "no upper bound." */
  endDate: z.string().nullable(),
  /**
   * `true` when a script exists under the reserved name but its content
   * does not match this project's own generated template (e.g. hand-edited
   * via the general Sieve editor) — `subject`/`message`/dates are `null`
   * in this case, never a guessed partial read; `enabled` still reflects
   * real activation state, which is independent of whether the content
   * parsed.
   */
  unrecognisedContent: z.boolean(),
});
export type AutoresponderStatus = z.infer<typeof AutoresponderStatusSchema>;

export const AutoresponderStatusResponseSchema = z.object({ status: AutoresponderStatusSchema });
export type AutoresponderStatusResponse = z.infer<typeof AutoresponderStatusResponseSchema>;

export const UpdateAutoresponderRequestSchema = z.object({
  enabled: z.boolean(),
  subject: z.string().min(1).max(255),
  message: z.string().min(1).max(10_000),
  startDate: AutoresponderDateSchema.optional(),
  endDate: AutoresponderDateSchema.optional(),
});
export type UpdateAutoresponderRequest = z.infer<typeof UpdateAutoresponderRequestSchema>;
