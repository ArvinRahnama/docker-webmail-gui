/**
 * Zod schemas for Rspamd, ClamAV and Fail2ban (M8 — FEATURE_MATRIX.md
 * §13-15 Rspamd/spam statistics/spam rules, §16 ClamAV, and the
 * Fail2ban row of `docs/research/03-mail-stack-components.md` §10).
 * Mirrors `mail.ts`/`security.ts`'s shape, reusing `CapabilityStatusSchema`
 * from `mail.ts` so every capability-gated tile renders from the same
 * document shape the rest of the app already does.
 *
 * The non-negotiable line this file enforces structurally: **there is no
 * schema anywhere below for a general Rspamd configuration write.** Only
 * an action threshold, a per-symbol score, and the two learn endpoints
 * have a request schema — matching FEATURE_MATRIX.md §15's explicit
 * allowlist and the refusal documented in SECURITY.md §3.13.
 */
import { z } from 'zod';
import { CapabilityStatusSchema } from './mail.js';

// ---------------------------------------------------------------------------
// Rspamd — §13 (read), §15 (constrained write: thresholds/symbol scores),
// §14 (spam statistics + our own sampled trend).
// ---------------------------------------------------------------------------

/**
 * Deliberately defensive (`docs/research/03-mail-stack-components.md`
 * §1's ★1: "this session could not pull the verbatim field list from an
 * official page — treat the exact key names as [INFERRED]"). Every field
 * is nullable; a field Rspamd's real `/stat` does not actually return
 * under a given config is `null`, never a fabricated `0`.
 */
export const RspamdStatSchema = z.object({
  scanned: z.number().nullable(),
  learned: z.number().nullable(),
  hamCount: z.number().nullable(),
  spamCount: z.number().nullable(),
  /** Raw action → count breakdown, whatever keys `/stat` actually reported this deployment's Rspamd version. */
  actions: z.record(z.string(), z.number()),
});
export type RspamdStat = z.infer<typeof RspamdStatSchema>;

export const RspamdSymbolSchema = z.object({
  name: z.string(),
  score: z.number(),
  description: z.string().nullable(),
  group: z.string().nullable(),
});
export type RspamdSymbol = z.infer<typeof RspamdSymbolSchema>;

export const RspamdActionThresholdSchema = z.object({
  action: z.string(),
  score: z.number().nullable(),
});
export type RspamdActionThreshold = z.infer<typeof RspamdActionThresholdSchema>;

export const RspamdStatusResponseSchema = z.object({
  capability: CapabilityStatusSchema,
  reachable: z.boolean(),
  error: z.string().nullable(),
  stat: RspamdStatSchema.nullable(),
  symbols: z.array(RspamdSymbolSchema),
  actions: z.array(RspamdActionThresholdSchema),
  /** `/history` is a 200-entry in-memory ring buffer that does not survive a restart — always stated alongside any history data, never left implicit (FEATURE_MATRIX.md §14). */
  historyCaveat: z.string(),
});
export type RspamdStatusResponse = z.infer<typeof RspamdStatusResponseSchema>;

/** The one allowed write beyond learn spam/ham (FEATURE_MATRIX.md §15) — a single action's score threshold. No endpoint anywhere accepts a raw Rspamd config document. */
export const SetRspamdActionThresholdRequestSchema = z.object({
  action: z.string().min(1).max(64),
  score: z.number().finite(),
});
export type SetRspamdActionThresholdRequest = z.infer<typeof SetRspamdActionThresholdRequestSchema>;

export const SetRspamdSymbolScoreRequestSchema = z.object({
  symbol: z.string().min(1).max(128),
  score: z.number().finite(),
});
export type SetRspamdSymbolScoreRequest = z.infer<typeof SetRspamdSymbolScoreRequestSchema>;

/** Confirmation-gated on the client (a distinct "confirm" step before this request is even sent) and audited server-side — training Bayes is a real, permanent effect on future scoring (FEATURE_MATRIX.md §15). Size-capped so this endpoint cannot become an arbitrary-upload vector. */
export const RspamdLearnRequestSchema = z.object({
  message: z.string().min(1).max(2_000_000),
});
export type RspamdLearnRequest = z.infer<typeof RspamdLearnRequestSchema>;

export const RspamdWriteResponseSchema = z.object({ ok: z.literal(true) });
export type RspamdWriteResponse = z.infer<typeof RspamdWriteResponseSchema>;

// ---------------------------------------------------------------------------
// Spam trend — our own `metric_samples` sampling (§1, §14). Never a
// fabricated line: `collecting: true` is the honest state before there is
// enough real data.
// ---------------------------------------------------------------------------

export const MetricSamplePointSchema = z.object({
  sampledAt: z.string(),
  value: z.number(),
});
export type MetricSamplePoint = z.infer<typeof MetricSamplePointSchema>;

export const RspamdTrendResponseSchema = z.object({
  /** `true` until enough of our own samples exist to draw a meaningful trend — the UI renders "Collecting" text, never a fabricated line, while this is `true` (FEATURE_MATRIX.md §1, §14). */
  collecting: z.boolean(),
  windowHours: z.number(),
  points: z.array(MetricSamplePointSchema),
});
export type RspamdTrendResponse = z.infer<typeof RspamdTrendResponseSchema>;

// ---------------------------------------------------------------------------
// ClamAV — §16.
// ---------------------------------------------------------------------------

export const ClamAvStatusResponseSchema = z.object({
  capability: CapabilityStatusSchema,
  reachable: z.boolean(),
  error: z.string().nullable(),
  /** Raw `VERSION` reply, e.g. `ClamAV 0.103.x/27xxx/Day Mon DD HH:MM:SS YYYY` — shown verbatim since the exact format is deployment-specific (FEATURE_MATRIX.md's deferred-verification table). */
  version: z.string().nullable(),
  /** Raw `STATS` reply — documented upstream as unstable free text, so parsed defensively and always available verbatim (FEATURE_MATRIX.md §16). */
  stats: z.string().nullable(),
});
export type ClamAvStatusResponse = z.infer<typeof ClamAvStatusResponseSchema>;

export const ClamAvUpdateResponseSchema = z.object({
  triggered: z.literal(true),
  output: z.string(),
});
export type ClamAvUpdateResponse = z.infer<typeof ClamAvUpdateResponseSchema>;

/**
 * Detection counts — clamd exposes no counter for this (research doc §2's
 * ★2), so the only route to a number is parsing the mail log
 * (`clamav.service.ts`, `drivers/dms/clamav-parser.ts`'s
 * `countClamavDetections`). `count`/`windowDescription` are both `null`
 * together — `available: false` is the single source of truth for "there
 * is no number to show," never a fabricated `0` standing in for "could not
 * check." `windowDescription` must always accompany a non-null `count`
 * (AGENT_BRIEF.md: "label them as log-derived with their retention
 * window") — this is a log-tail sample, not a lifetime total.
 */
export const ClamAvDetectionsResponseSchema = z.object({
  capability: CapabilityStatusSchema,
  available: z.boolean(),
  count: z.number().int().nonnegative().nullable(),
  windowDescription: z.string().nullable(),
  /** Safe-to-show reason when `available` is `false` (unsupported, or the log tail itself could not be read). */
  reason: z.string().nullable(),
});
export type ClamAvDetectionsResponse = z.infer<typeof ClamAvDetectionsResponseSchema>;

// ---------------------------------------------------------------------------
// Fail2ban (`docs/research/03-mail-stack-components.md` §10).
// ---------------------------------------------------------------------------

export const Fail2banStatusResponseSchema = z.object({
  capability: CapabilityStatusSchema,
  bannedIps: z.array(z.string()),
  /** Always present — `setup fail2ban status`'s output shape is explicitly unconfirmed upstream, so the raw text is the primary display, not a fallback-only field (FEATURE_MATRIX.md's deferred-verification table). */
  rawStatus: z.string(),
});
export type Fail2banStatusResponse = z.infer<typeof Fail2banStatusResponseSchema>;

export const Fail2banIpRequestSchema = z.object({
  ip: z.string().min(1).max(64),
});
export type Fail2banIpRequest = z.infer<typeof Fail2banIpRequestSchema>;

export const Fail2banWriteResponseSchema = z.object({ ok: z.literal(true) });
export type Fail2banWriteResponse = z.infer<typeof Fail2banWriteResponseSchema>;
