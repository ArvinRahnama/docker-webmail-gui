/**
 * Zod schemas for mail management (M7 — FEATURE_MATRIX.md §2 domains, §3
 * mailboxes, §4 aliases, §5 forwarding, §6 passwords, §7 quotas;
 * UX_ARCHITECTURE.md §5.2, §6.2, §6.3). Same artifact backs server-side
 * validation and client-side types (ARCHITECTURE.md §3).
 *
 * Two rules from FEATURE_MATRIX.md shape everything below:
 *
 *  - **Domains have no create/delete/enable.** There is no
 *    `DomainCreateRequestSchema` or equivalent anywhere in this file, on
 *    purpose (§2, §6.3) — a schema existing would be an invitation to wire
 *    a control the backend cannot perform.
 *  - **Aliases and forwarding are one mechanism** (§4, §5): a single
 *    `AliasSummarySchema` with a derived `type` field, not two schemas for
 *    two "kinds" of the same underlying `postfix-virtual.cf` row.
 */
import { z } from 'zod';
import { NewPasswordSchema } from './auth.js';

// ---------------------------------------------------------------------------
// Capabilities — mirrors apps/server/src/drivers/dms/capabilities.ts's
// `DmsCapabilities` shape exactly, so the web tier can render
// `UnsupportedNotice` from the same document the server used to decide
// whether to allow a mutation (FEATURE_MATRIX.md §7: "render a real
// UnsupportedNotice ... not an empty table").
// ---------------------------------------------------------------------------

export const CapabilityStatusSchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable(),
});
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const ACCOUNT_PROVISIONERS = ['FILE', 'LDAP', 'OIDC', 'UNKNOWN'] as const;
export type AccountProvisionerDto = (typeof ACCOUNT_PROVISIONERS)[number];
export const AccountProvisionerSchema = z.enum(ACCOUNT_PROVISIONERS);

export const MailCapabilitiesResponseSchema = z.object({
  quotas: CapabilityStatusSchema,
  rspamd: CapabilityStatusSchema,
  clamav: CapabilityStatusSchema,
  fail2ban: CapabilityStatusSchema,
  accountProvisioner: AccountProvisionerSchema,
  localAccountManagement: CapabilityStatusSchema,
});
export type MailCapabilitiesResponse = z.infer<typeof MailCapabilitiesResponseSchema>;

// ---------------------------------------------------------------------------
// Domains — read-only, derived (FEATURE_MATRIX.md §2; UX_ARCHITECTURE.md
// §6.3). No request schema for create/delete/enable exists anywhere below.
// ---------------------------------------------------------------------------

export const DomainSummarySchema = z.object({
  domain: z.string(),
  mailboxCount: z.number().int().nonnegative(),
  aliasCount: z.number().int().nonnegative(),
  /** True when every reference to this domain is alias-only — see `drivers/dms/domains.ts`'s `DerivedDomain`. */
  aliasOnly: z.boolean(),
});
export type DomainSummary = z.infer<typeof DomainSummarySchema>;

export const DomainListResponseSchema = z.object({
  domains: z.array(DomainSummarySchema),
});
export type DomainListResponse = z.infer<typeof DomainListResponseSchema>;

export const DomainDetailResponseSchema = z.object({
  domain: DomainSummarySchema,
  mailboxes: z.array(z.lazy(() => MailboxSummarySchema)),
  aliases: z.array(z.lazy(() => AliasSummarySchema)),
});
export type DomainDetailResponse = z.infer<typeof DomainDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Mailboxes (FEATURE_MATRIX.md §3)
// ---------------------------------------------------------------------------

export const MAILBOX_RESTRICT_SCOPES = ['send', 'receive'] as const;
export type MailboxRestrictScope = (typeof MAILBOX_RESTRICT_SCOPES)[number];
export const MailboxRestrictScopeSchema = z.enum(MAILBOX_RESTRICT_SCOPES);

/**
 * Current restriction state, read from `postfix-send-access.cf` /
 * `postfix-receive-access.cf` (`drivers/dms/real-dms-driver.ts`'s
 * `getRestrictedAddresses`). Never "disabled" — FEATURE_MATRIX.md §3 is
 * explicit that no such concept exists upstream; this is the one real
 * status DMS models for an account short of deleting it.
 */
export const MailboxRestrictionSchema = z.object({
  send: z.boolean(),
  receive: z.boolean(),
});
export type MailboxRestriction = z.infer<typeof MailboxRestrictionSchema>;

export const MailboxSummarySchema = z.object({
  // Plain z.string(), deliberately not .email() — this describes an
  // address DMS already has on disk (parsers/shared.ts's read path is
  // permissive by design), not new input being submitted. A strict
  // .email() here would make listing mailboxes crash the moment any
  // account's address doesn't fit a modern email regex — e.g. DMS's own
  // shipped dovecot-quotas.cf example file literally uses "user@domain"
  // (no TLD) as a placeholder. Write-path request schemas below (e.g.
  // CreateMailboxRequestSchema) keep .email() — validating *new* input
  // strictly is correct; refusing to *display* old input is not.
  email: z.string(),
  localPart: z.string(),
  domain: z.string(),
  /** Configured limit verbatim (e.g. `"2G"`), or `null` when no quota entry exists (unlimited). */
  quota: z.string().nullable(),
  restricted: MailboxRestrictionSchema,
});
export type MailboxSummary = z.infer<typeof MailboxSummarySchema>;

/**
 * Live usage, from `doveadm -f json quota get` (FEATURE_MATRIX.md §7).
 * `available: false` means the read failed or could not be confidently
 * parsed — rendered as `Unknown`, never a fabricated number
 * (UX_ARCHITECTURE.md §2 principle 2).
 */
export const MailboxUsageSchema = z.object({
  available: z.boolean(),
  storageBytesUsed: z.number().nonnegative().nullable(),
  storageBytesLimit: z.number().nonnegative().nullable(),
  messageCountUsed: z.number().nonnegative().nullable(),
  messageCountLimit: z.number().nonnegative().nullable(),
});
export type MailboxUsage = z.infer<typeof MailboxUsageSchema>;

export const MailboxListResponseSchema = z.object({
  mailboxes: z.array(MailboxSummarySchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  /** Count of lines in `postfix-accounts.cf` that could not be parsed — surfaced so the UI can show "N loaded, M unreadable" rather than silently under-counting (`drivers/dms/parsers/parse-result.ts`). */
  unparseableLines: z.number().int().nonnegative(),
});
export type MailboxListResponse = z.infer<typeof MailboxListResponseSchema>;

export const MailboxDetailResponseSchema = z.object({
  mailbox: MailboxSummarySchema,
  /** `null` when quotas are unsupported on this deployment (see `capabilities.quotas`) rather than an all-zero usage object. */
  usage: MailboxUsageSchema.nullable(),
  /** Aliases whose recipients include this mailbox — "dependent objects" for the Tier 3 delete impact summary (UX_ARCHITECTURE.md §8). */
  dependentAliases: z.array(z.lazy(() => AliasSummarySchema)),
});
export type MailboxDetailResponse = z.infer<typeof MailboxDetailResponseSchema>;

export const CreateMailboxRequestSchema = z.object({
  email: z.string().email(),
  password: NewPasswordSchema,
});
export type CreateMailboxRequest = z.infer<typeof CreateMailboxRequestSchema>;

export const CreateMailboxResponseSchema = z.object({ mailbox: MailboxSummarySchema });
export type CreateMailboxResponse = z.infer<typeof CreateMailboxResponseSchema>;

export const ChangeMailboxPasswordRequestSchema = z.object({ password: NewPasswordSchema });
export type ChangeMailboxPasswordRequest = z.infer<typeof ChangeMailboxPasswordRequestSchema>;

/** Deliberately `{ changed: true }`, never the password or its hash (FEATURE_MATRIX.md §6: "never returned by any endpoint"). */
export const ChangeMailboxPasswordResponseSchema = z.object({ changed: z.literal(true) });
export type ChangeMailboxPasswordResponse = z.infer<typeof ChangeMailboxPasswordResponseSchema>;

/** `restricted: true` applies the restriction (`setup email restrict add`); `false` removes it (`del`) — an explicit boolean, never an implied toggle, so a retried/duplicate request is idempotent. */
export const RestrictMailboxRequestSchema = z.object({
  scope: MailboxRestrictScopeSchema,
  restricted: z.boolean(),
});
export type RestrictMailboxRequest = z.infer<typeof RestrictMailboxRequestSchema>;

export const RestrictMailboxResponseSchema = z.object({ mailbox: MailboxSummarySchema });
export type RestrictMailboxResponse = z.infer<typeof RestrictMailboxResponseSchema>;

/** Matches `drivers/dms/validators.ts`'s `validateQuota` — duplicated here only for early client-side feedback; the server validator remains authoritative (ARCHITECTURE.md §3). */
export const QUOTA_VALUE_PATTERN = /^[0-9]+[bBkKmMgGtT]?$/;
export const QuotaValueSchema = z
  .string()
  .regex(
    QUOTA_VALUE_PATTERN,
    'must be digits optionally followed by a single unit letter, e.g. "50M" or "2G"',
  );

export const SetMailboxQuotaRequestSchema = z.object({ quota: QuotaValueSchema });
export type SetMailboxQuotaRequest = z.infer<typeof SetMailboxQuotaRequestSchema>;

export const SetMailboxQuotaResponseSchema = z.object({ mailbox: MailboxSummarySchema });
export type SetMailboxQuotaResponse = z.infer<typeof SetMailboxQuotaResponseSchema>;

/**
 * The mail-data keep/delete choice is **required**, mirroring
 * `drivers/dms/commands.ts`'s `MailDataChoice` — there is no default, and
 * this is deliberately not optional (FEATURE_MATRIX.md §3's "always pass
 * an explicit flag" rule; UX_ARCHITECTURE.md's Tier 3 "never defaulted").
 */
export const MailDataChoiceSchema = z.enum(['delete', 'keep']);
export type MailDataChoice = z.infer<typeof MailDataChoiceSchema>;

export const DeleteMailboxRequestSchema = z.object({ mailData: MailDataChoiceSchema });
export type DeleteMailboxRequest = z.infer<typeof DeleteMailboxRequestSchema>;

const BulkMailboxAddressesSchema = z.object({
  addresses: z.array(z.string().email()).min(1, 'at least one address is required'),
});

/** No bulk-delete request schema exists anywhere in this file (FEATURE_MATRIX.md §3: "the blast radius is unacceptable for mail data"). Only restrict and quota are bulk-capable. */
export const BulkRestrictMailboxRequestSchema = BulkMailboxAddressesSchema.extend({
  scope: MailboxRestrictScopeSchema,
  restricted: z.boolean(),
});
export type BulkRestrictMailboxRequest = z.infer<typeof BulkRestrictMailboxRequestSchema>;

export const BulkQuotaMailboxRequestSchema = BulkMailboxAddressesSchema.extend({
  /** `null` clears the quota for every listed address; a string sets the same value for all of them. */
  quota: QuotaValueSchema.nullable(),
});
export type BulkQuotaMailboxRequest = z.infer<typeof BulkQuotaMailboxRequestSchema>;

export interface BulkMailboxResultItem {
  readonly email: string;
  readonly ok: boolean;
  readonly error: string | null;
}
export const BulkMailboxResultItemSchema = z.object({
  email: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

/** Per-address outcome, never a single all-or-nothing flag — one invalid address in a bulk batch must not silently hide whether the other 49 succeeded. */
export const BulkMailboxResponseSchema = z.object({
  results: z.array(BulkMailboxResultItemSchema),
});
export type BulkMailboxResponse = z.infer<typeof BulkMailboxResponseSchema>;

// ---------------------------------------------------------------------------
// Aliases / forwarding — one mechanism, one schema family
// (FEATURE_MATRIX.md §4, §5).
// ---------------------------------------------------------------------------

/**
 * Derived, never stored: `internal` when every recipient is a local
 * mailbox, `external` when every recipient is not, `mixed` when both —
 * FEATURE_MATRIX.md §5's "type column distinguishing an internal alias
 * from an external forward," extended with `mixed` because a real
 * `postfix-virtual.cf` row can list both in one entry and collapsing that
 * to either label would misrepresent it.
 */
export const ALIAS_TYPES = ['internal', 'external', 'mixed'] as const;
export type AliasType = (typeof ALIAS_TYPES)[number];
export const AliasTypeSchema = z.enum(ALIAS_TYPES);

export const AliasSummarySchema = z.object({
  /**
   * Equal to `address`, URL-encode it to use as the `:id` path parameter
   * on `PUT|DELETE /api/v1/aliases/:id`. A `postfix-virtual.cf` row's
   * left-hand address *is* DMS's own natural key (one line per address —
   * FEATURE_MATRIX.md §4) — kept as a distinct named field rather than
   * asking every caller to re-derive it from `address`, and so a future
   * change to what identifies a row stays source-compatible.
   */
  id: z.string(),
  address: z.string(),
  isCatchAll: z.boolean(),
  domain: z.string(),
  recipients: z.array(z.string()).min(1),
  type: AliasTypeSchema,
});
export type AliasSummary = z.infer<typeof AliasSummarySchema>;

export const AliasListResponseSchema = z.object({
  aliases: z.array(AliasSummarySchema),
  unparseableLines: z.number().int().nonnegative(),
});
export type AliasListResponse = z.infer<typeof AliasListResponseSchema>;

export const CreateAliasRequestSchema = z.object({
  /** May be a catch-all (`@domain.tld`) — validated server-side by `drivers/dms/validators.ts`. */
  alias: z.string().min(1),
  recipients: z.array(z.string().email()).min(1, 'at least one recipient is required'),
});
export type CreateAliasRequest = z.infer<typeof CreateAliasRequestSchema>;

export const CreateAliasResponseSchema = z.object({ alias: AliasSummarySchema });
export type CreateAliasResponse = z.infer<typeof CreateAliasResponseSchema>;

/**
 * Replaces an alias's full recipient set in one call — FEATURE_MATRIX.md
 * §4's "Editing = delete + re-add (no upstream in-place edit); performed
 * atomically server-side and presented as a single edit." The service
 * diffs `recipients` against the alias's current set and issues exactly
 * the `addAlias`/`deleteAlias` calls needed, so the caller never
 * constructs that diff itself.
 */
export const UpdateAliasRequestSchema = z.object({
  recipients: z.array(z.string().email()).min(1, 'at least one recipient is required'),
});
export type UpdateAliasRequest = z.infer<typeof UpdateAliasRequestSchema>;

export const UpdateAliasResponseSchema = z.object({ alias: AliasSummarySchema });
export type UpdateAliasResponse = z.infer<typeof UpdateAliasResponseSchema>;

// ---------------------------------------------------------------------------
// Quotas / Storage — a usage report, not a CRUD page
// (UX_ARCHITECTURE.md §5.1 row 5, §6.2). Mutations reuse the mailbox quota
// endpoints; this is deliberately read-only in the schema layer too.
// ---------------------------------------------------------------------------

export const QuotaReportEntrySchema = z.object({
  // Plain z.string() — same reasoning as MailboxSummarySchema.email above.
  // dovecot-quotas.cf's own shipped example (§7) uses "user@domain" (no
  // TLD), which is real, already-on-disk data this report must still be
  // able to display.
  email: z.string(),
  domain: z.string(),
  quota: z.string().nullable(),
  usage: MailboxUsageSchema.nullable(),
  /** `usage.storageBytesUsed / usage.storageBytesLimit`, pre-computed so every consumer sorts/warns identically; `null` when either side is unavailable or the quota is unlimited. */
  percentUsed: z.number().nonnegative().nullable(),
});
export type QuotaReportEntry = z.infer<typeof QuotaReportEntrySchema>;

export const QuotaListResponseSchema = z.object({
  entries: z.array(QuotaReportEntrySchema),
});
export type QuotaListResponse = z.infer<typeof QuotaListResponseSchema>;

// ---------------------------------------------------------------------------
// Mail queue (FEATURE_MATRIX.md §1; M11 gap-closing pass — `/mail/queue`,
// UX_ARCHITECTURE.md §5.2's "Mail > Queue... a stuck queue is a top-three
// real incident and postqueue -j gives us genuine per-message data").
// **Read-only.** `postqueue -f` (force delivery) and `postsuper`
// (requeue/hold/release/delete) are real, documented Postfix operations
// this project has not wired up — a named, reachable gap
// (`UX_ARCHITECTURE.md` §5.2), not something this schema pretends to
// support. No request schema exists here for any of them.
// ---------------------------------------------------------------------------

export const MAIL_QUEUE_NAMES = ['incoming', 'active', 'deferred', 'hold'] as const;
export type MailQueueName = (typeof MAIL_QUEUE_NAMES)[number];
export const MailQueueNameSchema = z.enum(MAIL_QUEUE_NAMES);

/**
 * Deliberately narrow — `queueId`/`arrivalTime`/`messageSizeBytes`/
 * `sender`/`recipientCount` only, matching exactly what
 * `drivers/dms/parsers/postqueue.ts` extracts server-side. The full
 * per-recipient detail (`recipients[].address`/`delay_reason`) belongs to
 * a queue *management* view with its own confirmation tiers, not this
 * read-only report.
 */
export const MailQueueEntrySchema = z.object({
  queueName: MailQueueNameSchema,
  queueId: z.string(),
  /** Seconds since epoch, `postqueue -j`'s own unit. */
  arrivalTime: z.number(),
  messageSizeBytes: z.number().nonnegative(),
  sender: z.string(),
  recipientCount: z.number().nonnegative(),
});
export type MailQueueEntry = z.infer<typeof MailQueueEntrySchema>;

export const MailQueueListResponseSchema = z.object({
  entries: z.array(MailQueueEntrySchema),
  /** Every {@link MAIL_QUEUE_NAMES} key always present, zero-filled — see `drivers/dms/parsers/postqueue.ts`'s `countByQueueName`, which computes this server-side. */
  byQueue: z.record(MailQueueNameSchema, z.number().nonnegative()),
  /** Lines `postqueue -j` emitted that could not be parsed — surfaced so this report can say "N loaded, M unreadable" instead of silently under-counting, the same discipline as every other `ParseResult`-backed DMS read. */
  unparseableLines: z.number().nonnegative(),
});
export type MailQueueListResponse = z.infer<typeof MailQueueListResponseSchema>;
