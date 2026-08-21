/**
 * The configuration/environment editor (M10 — FEATURE_MATRIX.md §28-29;
 * SECURITY.md §3.10 "Editable config files are a server-side allowlist of
 * DMS paths"). Fixed flow: validate -> diff -> impact -> confirm -> apply
 * -> verify -> audit (this milestone's brief) — every schema below exists
 * to name one step of that pipeline.
 *
 * **Scope decision, stated plainly because it narrows FEATURE_MATRIX §29's
 * wording:** DMS's actual configuration surface is overwhelmingly
 * environment variables passed at container *creation* — there is no
 * Docker operation that live-updates a running container's environment,
 * only recreate (`docs/research/01-docker-mailserver.md` §9, confirmed
 * against the shipped `mailserver.env` template). This editor therefore
 * models editable state as **named settings** (`ConfigSettingSchema`
 * below) read from the managed container's live environment, not as raw
 * file text — every setting an admin can change here is still addressed
 * through one server-side allowlist (`SETTINGS_ALLOWLIST`,
 * `modules/config/settings-allowlist.ts`), matching SECURITY.md's
 * requirement in spirit and letter: no client-supplied key ever reaches
 * the driver, an unknown key is rejected the same way an out-of-allowlist
 * path would be. One entry (`LDAP_BIND_PW`) is included on the strength of
 * `docs/research/01-docker-mailserver.md` §8 confirming an `LDAP_*`
 * variable block exists, without independently re-confirming that exact
 * variable name against upstream source in this pass — flagged here so
 * that hedge travels with the code, not just this comment.
 */
import { z } from 'zod';

export const CONFIG_SETTING_CLASSIFICATIONS = [
  'read-only',
  'editable-live',
  'needs-restart',
  'needs-recreate',
] as const;
export type ConfigSettingClassification = (typeof CONFIG_SETTING_CLASSIFICATIONS)[number];
export const ConfigSettingClassificationSchema = z.enum(CONFIG_SETTING_CLASSIFICATIONS);

/**
 * One allowlisted setting's current state. `value` is `null` for a secret
 * the caller may not reveal (masked) and for an unset variable; masking is
 * applied server-side before this ever reaches a response body — see
 * `modules/config/config.service.ts`'s `describe`/`reveal` split.
 */
export const ConfigSettingSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  classification: ConfigSettingClassificationSchema,
  secret: z.boolean(),
  /** `true` when a secret's real value is currently masked in this response — always `false` for a non-secret setting. */
  masked: z.boolean(),
  value: z.string().nullable(),
});
export type ConfigSetting = z.infer<typeof ConfigSettingSchema>;

export const ConfigSettingsResponseSchema = z.object({
  settings: z.array(ConfigSettingSchema),
});
export type ConfigSettingsResponse = z.infer<typeof ConfigSettingsResponseSchema>;

/** `POST /config/settings/:key/reveal` — the unmasked value plus the audit event this call itself writes (ARCHITECTURE.md §7.6: "revealing a masked secret is itself an audited event"). */
export const RevealSettingResponseSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
});
export type RevealSettingResponse = z.infer<typeof RevealSettingResponseSchema>;

// ---------------------------------------------------------------------------
// Validate + diff. `POST /config/validate` takes a proposed change set (a
// partial key -> new value map) and returns, per key, whether it is even
// allowed to change plus what its new-vs-current diff and impact look
// like — computed **before** anything is applied, so the UI can render
// the required diff/impact/confirm steps from one response.
// ---------------------------------------------------------------------------

export const ConfigChangeSetSchema = z.record(z.string(), z.string());
export type ConfigChangeSet = z.infer<typeof ConfigChangeSetSchema>;

export const ConfigChangeValidationSchema = z.object({
  key: z.string(),
  /** `false` when `key` is not in the server-side allowlist at all, or the setting is `read-only` — the two ways a proposed change is simply refused, never partially honoured. */
  allowed: z.boolean(),
  /** Present only when `allowed` is `false`. */
  reason: z.string().nullable(),
  classification: ConfigSettingClassificationSchema.nullable(),
  currentValue: z.string().nullable(),
  proposedValue: z.string(),
});
export type ConfigChangeValidation = z.infer<typeof ConfigChangeValidationSchema>;

export const ValidateConfigRequestSchema = z.object({ changes: ConfigChangeSetSchema });
export type ValidateConfigRequest = z.infer<typeof ValidateConfigRequestSchema>;

export const ValidateConfigResponseSchema = z.object({
  /** `true` only when every entry in the change set is `allowed` — the apply route re-runs this exact check server-side and refuses wholesale (never partially) when it is `false`, so a client cannot skip straight to apply with a stale/hand-crafted request. */
  valid: z.boolean(),
  changes: z.array(ConfigChangeValidationSchema),
  /**
   * The single highest-impact classification across the change set —
   * `needs-recreate` > `needs-restart` > `editable-live` — drives which
   * `ConfirmDialog` tier the UI shows (UX_ARCHITECTURE.md §8: destructive
   * config apply is Tier 4 whenever recreation is involved).
   */
  highestImpact: ConfigSettingClassificationSchema.nullable(),
});
export type ValidateConfigResponse = z.infer<typeof ValidateConfigResponseSchema>;

// ---------------------------------------------------------------------------
// Apply. Mirrors the restore/update Tier 4 shape exactly: an explicit,
// never-defaulted `confirm`. There is no separate backup-gate
// acknowledgement here — a config change (unlike restore/update) does not
// touch mail data, so IMPLEMENTATION_PLAN.md §2.1's backup gate does not
// apply; the snapshot this route takes *is* its rollback mechanism
// (FEATURE_MATRIX.md §28-29: "a pre-change snapshot enables rollback").
// ---------------------------------------------------------------------------

export const ApplyConfigRequestSchema = z.object({
  changes: ConfigChangeSetSchema,
  confirm: z.literal(true),
});
export type ApplyConfigRequest = z.infer<typeof ApplyConfigRequestSchema>;

export const ConfigSnapshotSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  createdByAdminId: z.string().nullable(),
  createdByLabel: z.string(),
  /** The full allowlisted settings state at snapshot time, key -> value (secrets included, unmasked — this row is never exposed over the API; see `config.repository.ts`). */
  values: z.record(z.string(), z.string()),
});

export const ApplyConfigResponseSchema = z.object({
  applied: z.array(z.string()),
  snapshotId: z.string(),
});
export type ApplyConfigResponse = z.infer<typeof ApplyConfigResponseSchema>;

export type ConfigSnapshotRecord = z.infer<typeof ConfigSnapshotSchema>;

// ---------------------------------------------------------------------------
// Snapshot listing + rollback. `ConfigSnapshotSchema` above is
// deliberately never sent over the wire (its own doc comment: `values`
// carries unmasked secrets) — this is the safe subset a client can list
// to pick a rollback target, identity and provenance only.
// ---------------------------------------------------------------------------

export const ConfigSnapshotSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  createdByAdminId: z.string().nullable(),
  createdByLabel: z.string(),
});
export type ConfigSnapshotSummary = z.infer<typeof ConfigSnapshotSummarySchema>;

export const ConfigSnapshotListResponseSchema = z.object({
  snapshots: z.array(ConfigSnapshotSummarySchema),
});
export type ConfigSnapshotListResponse = z.infer<typeof ConfigSnapshotListResponseSchema>;

/** `POST /config/snapshots/:id/rollback` — same never-defaulted `confirm` as apply; rollback is itself a config change (`config.service.ts`'s `rollback` doc comment). */
export const RollbackConfigRequestSchema = z.object({ confirm: z.literal(true) });
export type RollbackConfigRequest = z.infer<typeof RollbackConfigRequestSchema>;
