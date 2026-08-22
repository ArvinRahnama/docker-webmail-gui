/**
 * `GET /api/v1/dashboard` (M11 — IMPLEMENTATION_PLAN.md §3's exit
 * criterion: "Dashboard renders with a subsystem down"; UX_ARCHITECTURE.md
 * §6.1; FEATURE_MATRIX.md §1). One response, composed from many
 * independent subsystems — each tile below is only as real as its source,
 * and each is isolated server-side so one unreachable subsystem degrades
 * its own tile to `unknown` rather than failing the whole request
 * (FEATURE_MATRIX.md §1: "per-tile failures isolated so one dead
 * subsystem cannot blank the page").
 *
 * **What this deliberately does not claim**, because nothing in this
 * codebase can back it honestly (AGENT_BRIEF.md working agreement #1 —
 * "no control ships that the backend cannot perform" applies to a
 * read-only tile exactly as it does to a button):
 *
 *  - No "mail flow (24h) sent/received" tile. `docs/research/*` confirms
 *    `postqueue -j` (a live snapshot of what's *currently* queued, not a
 *    24h flow count) and Rspamd `/stat`'s lifetime scanned counter — an
 *    honest 24h send/receive rate has no real source in this codebase.
 *  - No per-domain DKIM/SPF/DMARC rollup. `email-auth-list-page.tsx`
 *    already made this exact call for its own list view: N domains would
 *    mean N live DNS checks on every load, against a resolver that is
 *    genuinely rate-limited and SSRF-hardened (SECURITY.md §3.4) — this
 *    endpoint follows that precedent rather than reopening it.
 *  - "Disk used/total" is Docker's own storage accounting
 *    ({@link DashboardStorageTile}, reusing `SystemDfResponseSchema`
 *    verbatim), never a host-filesystem free/used percentage — no
 *    capability in this codebase reads the host filesystem for the data
 *    path (`docker.ts`'s own header only confirms `GET /system/df`; see
 *    that schema's doc comment).
 *  - No "Postfix"/"Dovecot" rows in {@link DashboardResponse.serviceHealth}.
 *    Neither exposes an independent liveness signal in this stack; the
 *    managed container's own health check (already in the list) is the
 *    real proxy for both, and fabricating a separate always-green row for
 *    each would be exactly the "feature the backend cannot perform" this
 *    project refuses to ship.
 */
import { z } from 'zod';
import { HealthCheckStateSchema } from './docker.js';
import { SystemDfResponseSchema } from './broker.js';

// ---------------------------------------------------------------------------
// A "signal" — one row in the verdict's problem list and/or the service
// health list. Reuses `HealthCheckStateSchema` (`docker.ts`'s own health
// centre) rather than declaring a second, parallel four-state enum.
// ---------------------------------------------------------------------------

export const DashboardSignalSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: HealthCheckStateSchema,
  message: z.string().nullable(),
  /** App-relative path to the page that explains or fixes this, or `null` when this project genuinely has nowhere more specific to send the admin than the dashboard itself already is. */
  link: z.string().nullable(),
  checkedAt: z.string(),
});
export type DashboardSignal = z.infer<typeof DashboardSignalSchema>;

/**
 * Row 1 (§6.1): one headline plus, when not healthy, the list of signals
 * that made it so. `problems` includes every non-healthy signal —
 * `warning`, `critical` *and* `unknown` — because "we could not check
 * this" is not the same claim as "healthy" (AGENT_BRIEF.md §4's DNS-state
 * discipline). Each row still renders its own true state via `StatusBadge`
 * client-side, so an `unknown` problem is never visually confused with a
 * `critical` one even though both count toward the headline number.
 */
export const DashboardVerdictSchema = z.object({
  tone: HealthCheckStateSchema,
  headline: z.string(),
  problems: z.array(DashboardSignalSchema),
});
export type DashboardVerdict = z.infer<typeof DashboardVerdictSchema>;

// ---------------------------------------------------------------------------
// Row 2 — four metric tiles.
// ---------------------------------------------------------------------------

export const DASHBOARD_TILE_STATES = ['ok', 'unknown'] as const;
export type DashboardTileState = (typeof DASHBOARD_TILE_STATES)[number];
export const DashboardTileStateSchema = z.enum(DASHBOARD_TILE_STATES);

/** `postqueue -j`, grouped by `queue_name` (`drivers/dms/parsers/postqueue.ts`) — genuinely real, current queue depth. */
export const DashboardQueueTileSchema = z.object({
  state: DashboardTileStateSchema,
  message: z.string().nullable(),
  total: z.number().nonnegative().nullable(),
  /** UX_ARCHITECTURE.md §6.1 Row 2: "Queue depth with deferred count" — called out on its own since a growing deferred count is the actionable signal, not the total. */
  deferred: z.number().nonnegative().nullable(),
  byQueue: z.record(z.string(), z.number().nonnegative()).nullable(),
});
export type DashboardQueueTile = z.infer<typeof DashboardQueueTileSchema>;

/**
 * Rspamd's own lifetime `scanned`/`spam_count` counters have no window —
 * "blocked in the last 24h" is a *delta* over our own periodic samples
 * (`rspamd-sampler.ts`'s `metric_samples`), so this reuses that module's
 * exact "Collecting" gate rather than inventing a second one
 * (FEATURE_MATRIX.md §1: "Shows 'Collecting — trend available after 24h'
 * until samples exist").
 */
export const DashboardSpamBlockedTileSchema = z.object({
  collecting: z.boolean(),
  windowHours: z.number().positive(),
  count: z.number().nonnegative().nullable(),
});
export type DashboardSpamBlockedTile = z.infer<typeof DashboardSpamBlockedTileSchema>;

/** Docker's own storage accounting — see this file's header for why this is not, and does not claim to be, host disk usage. */
export const DashboardStorageTileSchema = z.object({
  state: DashboardTileStateSchema,
  message: z.string().nullable(),
  df: SystemDfResponseSchema.nullable(),
});
export type DashboardStorageTile = z.infer<typeof DashboardStorageTileSchema>;

/** Mailbox/alias/domain counts — cheap, always-available config-file parses (FEATURE_MATRIX.md §1: all three rows "Full"). */
export const DashboardMailCountsTileSchema = z.object({
  state: DashboardTileStateSchema,
  message: z.string().nullable(),
  mailboxCount: z.number().nonnegative().nullable(),
  domainCount: z.number().nonnegative().nullable(),
  aliasCount: z.number().nonnegative().nullable(),
});
export type DashboardMailCountsTile = z.infer<typeof DashboardMailCountsTileSchema>;

export const DashboardMetricsSchema = z.object({
  queue: DashboardQueueTileSchema,
  spamBlocked: DashboardSpamBlockedTileSchema,
  storage: DashboardStorageTileSchema,
  mail: DashboardMailCountsTileSchema,
});
export type DashboardMetrics = z.infer<typeof DashboardMetricsSchema>;

// ---------------------------------------------------------------------------
// Row 3, right column — security & expiry.
// ---------------------------------------------------------------------------

export const DashboardSecurityExpirySchema = z.object({
  tlsState: HealthCheckStateSchema,
  /** Days until the soonest-expiring configured TLS endpoint's certificate expires; may be negative for an already-expired one. `null` when unknown. */
  tlsExpiryDays: z.number().nullable(),
  lastBackupAt: z.string().nullable(),
  /** `null` when no backup exists at all yet — distinct from `false` (a backup exists but its most recent verification failed or none has ever been verified). */
  lastBackupVerified: z.boolean().nullable(),
  /** `null` when the comparison could not be made at all (AGENT_BRIEF.md §4: "A registry that cannot be reached yields Unknown, never up to date" — the same discipline `updates-page.tsx` already implements, reused here rather than re-decided). */
  updateAvailable: z.boolean().nullable(),
});
export type DashboardSecurityExpiry = z.infer<typeof DashboardSecurityExpirySchema>;

// ---------------------------------------------------------------------------
// Row 4 — recent activity. Audit log only — see this file's header on why
// there is no Docker-events half of this feed (no `systemEvents`/`events`
// broker operation exists in `BROKER_OPERATIONS`, despite
// UX_ARCHITECTURE.md §5.2 naming a `/docker/events` page and
// FEATURE_MATRIX.md §1 citing "Docker /events" as a source; adding a new
// broker operation is a bigger architectural decision than this milestone,
// so this is a deliberate, reported scope cut rather than a silent one).
// ---------------------------------------------------------------------------

export const DashboardActivityEntrySchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actorLabel: z.string(),
  /** The raw `AuditAction` string (`platform/audit.ts` — server-internal, not re-exported here to avoid a second copy of that enum drifting from the real one); the client formats it for display. */
  action: z.string(),
  target: z.string().nullable(),
  result: z.enum(['success', 'failure']),
});
export type DashboardActivityEntry = z.infer<typeof DashboardActivityEntrySchema>;

export const DashboardResponseSchema = z.object({
  generatedAt: z.string(),
  verdict: DashboardVerdictSchema,
  metrics: DashboardMetricsSchema,
  /** Row 3, left column. */
  serviceHealth: z.array(DashboardSignalSchema),
  securityExpiry: DashboardSecurityExpirySchema,
  recentActivity: z.array(DashboardActivityEntrySchema),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
