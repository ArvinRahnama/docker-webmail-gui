/**
 * Zod contracts for the postmaster-controlled MCP integration
 * (`docs/mcp-integration.md`). One artifact backs three consumers:
 *
 *  - `apps/mcp` — the isolated MCP runtime and OAuth authorization server,
 *    which validates every control-plane request against these schemas;
 *  - `apps/server` — the admin tier, which proxies postmaster actions to
 *    `apps/mcp`'s internal control API and validates both directions;
 *  - `apps/web` — the admin SPA, which renders these DTOs.
 *
 * Two rules shape everything below:
 *
 *  1. **No schema here carries a recoverable secret in a response.** The
 *     one-time setup password appears in exactly one response type
 *     ({@link McpOneTimeCredentialSchema}, returned by create/reissue/rotate)
 *     and is never stored in plaintext anywhere, so there is no "reveal"
 *     schema to accidentally wire. The mailbox's IMAP/SMTP password appears
 *     only in *request* schemas, travelling admin SPA → admin server →
 *     MCP vault, and is never echoed back.
 *  2. **Mailbox identity is never client-chosen at tool-call time.** These
 *     are management contracts; the MCP tool schemas in `apps/mcp` carry no
 *     mailbox field at all.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scopes / permissions
// ---------------------------------------------------------------------------

/**
 * The three OAuth scopes a connection can be granted. `mail.delete` means
 * *move to Trash* (and restore) — permanent purge is deliberately not part
 * of any scope in this feature.
 */
export const MCP_SCOPES = ['mail.read', 'mail.send', 'mail.delete'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const McpScopeSchema = z.enum(MCP_SCOPES);

/** A non-empty, de-duplicated scope list. */
export const McpScopeListSchema = z
  .array(McpScopeSchema)
  .min(1, 'at least one permission must be enabled')
  .max(MCP_SCOPES.length)
  .transform((scopes) => MCP_SCOPES.filter((scope) => scopes.includes(scope)));

/** Human labels, used by the admin UI, the OAuth consent page, and the connection package. */
export const MCP_SCOPE_LABELS: Readonly<Record<McpScope, string>> = {
  'mail.read': 'Read and search messages',
  'mail.send': 'Send messages as this mailbox',
  'mail.delete': 'Move messages to Trash (and restore them)',
};

/** Bump when the admin-server ↔ MCP control API changes incompatibly. */
export const MCP_CONTROL_PROTOCOL_VERSION = 1;

/** Header carrying the control-plane shared secret (admin server → apps/mcp only). */
export const MCP_CONTROL_AUTH_HEADER = 'x-dwg-mcp-control-secret';

// ---------------------------------------------------------------------------
// Small reusable fields
// ---------------------------------------------------------------------------

/** Mailbox addresses: same strictness as mailbox creation, lower-cased. */
export const McpMailboxAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());

/** Connection ids are `c` + 26 lower-case base32 chars (128 random bits) — see apps/mcp/src/ids.ts. */
export const McpConnectionIdSchema = z.string().regex(/^c[0-9a-z]{26}$/, 'invalid connection id');

export const McpConnectionLabelSchema = z.string().trim().min(1).max(80);

/** An opaque SHA-256 fingerprint of the DMS password-hash line (hex). Never the hash itself. */
export const McpMailboxFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A mailbox IMAP/SMTP password submitted for provisioning. Bounded, never
 * policy-checked: it is an existing credential, not one being set.
 */
export const McpMailboxCredentialPasswordSchema = z.string().min(1).max(256);

const HostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, 'must be a hostname (letters, digits, dots and hyphens)');

const PortSchema = z.number().int().min(1).max(65535);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const MCP_TRANSPORT_SECURITY = ['tls', 'starttls'] as const;
export type McpTransportSecurity = (typeof MCP_TRANSPORT_SECURITY)[number];

export const McpMailSettingsSchema = z.object({
  imapHost: HostnameSchema,
  imapPort: PortSchema,
  /** `tls` = implicit TLS (993); `starttls` = upgrade on 143. Plain text is not offered. */
  imapSecurity: z.enum(MCP_TRANSPORT_SECURITY),
  smtpHost: HostnameSchema,
  smtpPort: PortSchema,
  /** `tls` = implicit TLS (465); `starttls` = required STARTTLS on 587. Plain text is not offered. */
  smtpSecurity: z.enum(MCP_TRANSPORT_SECURITY),
  /**
   * The name to verify the mail server's certificate against, when it
   * differs from the host connected to (e.g. connect to `mailserver`,
   * verify `mail.example.com`). `null` = verify against the host.
   */
  tlsServername: HostnameSchema.nullable(),
  /** Certificate verification. Disabling it is possible but loudly flagged everywhere. */
  tlsVerify: z.boolean(),
});
export type McpMailSettings = z.infer<typeof McpMailSettingsSchema>;

export const McpRateLimitSettingsSchema = z.object({
  toolCallsPerMinute: z.number().int().min(1).max(600),
  sendsPerHour: z.number().int().min(0).max(1000),
  sendsPerDay: z.number().int().min(0).max(10000),
  maxRecipientsPerMessage: z.number().int().min(1).max(100),
});
export type McpRateLimitSettings = z.infer<typeof McpRateLimitSettingsSchema>;

export const McpClientRegistrationSettingsSchema = z.object({
  /** OAuth Dynamic Client Registration (RFC 7591) — deprecated by MCP 2026-07-28 but still used by some clients. */
  dynamicRegistration: z.boolean(),
  /** OAuth Client ID Metadata Documents — the MCP 2026-07-28 default. */
  metadataDocuments: z.boolean(),
  /** Optional trust policy: when non-empty, only metadata documents hosted on these hosts are accepted. */
  allowedMetadataHosts: z.array(HostnameSchema.transform((h) => h.toLowerCase())).max(32),
});

export const McpSettingsSchema = z.object({
  /** Global kill switch. Off by default on every install, fresh or upgraded. */
  enabled: z.boolean(),
  /** Public HTTPS origin the reverse proxy serves apps/mcp on, e.g. `https://mcp.example.com`. */
  publicBaseUrl: z.string().url().nullable(),
  mail: McpMailSettingsSchema,
  setupCredentialTtlHours: z.number().int().min(1).max(168),
  /** Default connection lifetime for new connections; `null` = no expiry. */
  connectionExpiryDays: z.number().int().min(1).max(3650).nullable(),
  defaultPermissions: z.array(McpScopeSchema).max(MCP_SCOPES.length),
  maxConnectionsPerMailbox: z.number().int().min(1).max(50),
  auditRetentionDays: z.number().int().min(7).max(3650),
  accessTokenTtlMinutes: z.number().int().min(5).max(60),
  refreshTokenTtlDays: z.number().int().min(1).max(365),
  rateLimits: McpRateLimitSettingsSchema,
  /** Hard ceiling on a single attachment returned by `mail_get_attachment` or accepted by `mail_send`. */
  maxAttachmentBytes: z
    .number()
    .int()
    .min(1024)
    .max(25 * 1024 * 1024),
  /** File a copy of every sent message in the mailbox's Sent folder over IMAP. */
  saveSentCopies: z.boolean(),
  clientRegistration: McpClientRegistrationSettingsSchema,
});
export type McpSettings = z.infer<typeof McpSettingsSchema>;

/**
 * Partial update. Nested objects (`mail`, `rateLimits`,
 * `clientRegistration`) are replaced whole when present — a half-specified
 * transport configuration is a misconfiguration, not a patch.
 */
export const McpSettingsPatchSchema = McpSettingsSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'at least one setting must be provided' },
);
export type McpSettingsPatch = z.infer<typeof McpSettingsPatchSchema>;

export const McpSettingsResponseSchema = z.object({
  settings: McpSettingsSchema,
  /** Derived, read-only: the OAuth issuer this configuration advertises (`null` until a public URL is set). */
  issuer: z.string().nullable(),
  /** Non-fatal configuration warnings worth showing next to the form. */
  warnings: z.array(z.string()),
});
export type McpSettingsResponse = z.infer<typeof McpSettingsResponseSchema>;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const MCP_CONNECTION_STATUSES = [
  /** Created; no OAuth grant yet. Setup credentials may still be valid. */
  'pending',
  /** At least one live OAuth grant. */
  'active',
  /** Postmaster-disabled. Reversible. Tokens are refused while disabled. */
  'disabled',
  /** System-suspended because the mailbox credential/identity is not trustworthy. */
  'suspended',
  /** Connection lifetime elapsed. */
  'expired',
  /** Permanently revoked. Terminal. */
  'revoked',
] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];
export const McpConnectionStatusSchema = z.enum(MCP_CONNECTION_STATUSES);

export const MCP_ENROLLMENT_STATES = [
  'active',
  'consumed',
  'expired',
  'locked',
  'revoked',
  'none',
] as const;
export type McpEnrollmentState = (typeof MCP_ENROLLMENT_STATES)[number];

export const MCP_CREDENTIAL_HEALTH = [
  /** Encrypted credential stored, last verification succeeded. */
  'healthy',
  /** No credential provisioned yet. */
  'missing',
  /** The mailbox password changed (or the mailbox was recreated) since provisioning. */
  'stale',
  /** The mail server rejected the stored credential. */
  'invalid',
  /** The mailbox was not present in the last reconciliation. */
  'mailbox_missing',
  /** The mailbox was deleted; the binding is permanently revoked. */
  'revoked',
  /** The vault key is missing or does not match the stored ciphertext. */
  'vault_unavailable',
] as const;
export type McpCredentialHealth = (typeof MCP_CREDENTIAL_HEALTH)[number];

export const McpEnrollmentSummarySchema = z.object({
  username: z.string().nullable(),
  state: z.enum(MCP_ENROLLMENT_STATES),
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  consumedAt: z.string().nullable(),
  failedAttempts: z.number().int().nonnegative(),
});
export type McpEnrollmentSummary = z.infer<typeof McpEnrollmentSummarySchema>;

export const McpConnectionSummarySchema = z.object({
  id: McpConnectionIdSchema,
  label: z.string(),
  mailbox: z.string(),
  /** The unique MCP endpoint URL. Identifies the connection; never sufficient to authenticate. */
  mcpUrl: z.string().nullable(),
  permissions: z.array(McpScopeSchema),
  status: McpConnectionStatusSchema,
  statusReason: z.string().nullable(),
  enrollment: McpEnrollmentSummarySchema,
  credentialHealth: z.enum(MCP_CREDENTIAL_HEALTH),
  senderIdentities: z.array(z.string()),
  activeGrantCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
  /** Last successful OAuth authorization (consent) — `null` if never. Never invented. */
  lastAuthorizedAt: z.string().nullable(),
  /** Last authenticated MCP request — `null` if never. Never invented. */
  lastUsedAt: z.string().nullable(),
});
export type McpConnectionSummary = z.infer<typeof McpConnectionSummarySchema>;

export const McpGrantSummarySchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string().nullable(),
  /** Host of the redirect URI the grant was issued to — what the consent page showed. */
  redirectHost: z.string(),
  scopes: z.array(McpScopeSchema),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
});
export type McpGrantSummary = z.infer<typeof McpGrantSummarySchema>;

export const McpBindingSummarySchema = z.object({
  mailbox: z.string(),
  credentialHealth: z.enum(MCP_CREDENTIAL_HEALTH),
  credentialProvisionedAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type McpBindingSummary = z.infer<typeof McpBindingSummarySchema>;

export const McpConnectionDetailSchema = McpConnectionSummarySchema.extend({
  grants: z.array(McpGrantSummarySchema),
  binding: McpBindingSummarySchema,
});
export type McpConnectionDetail = z.infer<typeof McpConnectionDetailSchema>;

export const McpConnectionListQuerySchema = z.object({
  search: z.string().trim().max(254).optional(),
  status: McpConnectionStatusSchema.optional(),
  mailbox: z.string().trim().max(254).optional(),
});
export type McpConnectionListQuery = z.infer<typeof McpConnectionListQuerySchema>;

export const McpConnectionListResponseSchema = z.object({
  connections: z.array(McpConnectionSummarySchema),
});
export type McpConnectionListResponse = z.infer<typeof McpConnectionListResponseSchema>;

export const McpConnectionDetailResponseSchema = z.object({
  connection: McpConnectionDetailSchema,
});
export type McpConnectionDetailResponse = z.infer<typeof McpConnectionDetailResponseSchema>;

/** The *only* response type that ever carries a plaintext setup password — shown once, never retrievable again. */
export const McpOneTimeCredentialSchema = z.object({
  username: z.string(),
  setupPassword: z.string(),
  expiresAt: z.string(),
});
export type McpOneTimeCredential = z.infer<typeof McpOneTimeCredentialSchema>;

/** Admin SPA → admin server. The server resolves and attaches the mailbox fingerprint itself. */
export const CreateMcpConnectionRequestSchema = z.object({
  mailbox: McpMailboxAddressSchema,
  label: McpConnectionLabelSchema,
  permissions: McpScopeListSchema,
  /** `undefined` = use the configured default; `null` = never expires. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  /**
   * The mailbox's IMAP/SMTP password. Required when no healthy credential
   * is already provisioned for this mailbox; optional (and, if given,
   * replaces the stored one) otherwise.
   */
  mailboxPassword: McpMailboxCredentialPasswordSchema.optional(),
});
export type CreateMcpConnectionRequest = z.infer<typeof CreateMcpConnectionRequestSchema>;

export const CreateMcpConnectionResponseSchema = z.object({
  connection: McpConnectionDetailSchema,
  oneTimeCredential: McpOneTimeCredentialSchema,
});
export type CreateMcpConnectionResponse = z.infer<typeof CreateMcpConnectionResponseSchema>;

export const UpdateMcpConnectionRequestSchema = z
  .object({
    label: McpConnectionLabelSchema.optional(),
    permissions: McpScopeListSchema.optional(),
    /** `null` clears expiry. */
    expiresAt: z.string().datetime().nullable().optional(),
    /** Additional `From:` identities; the server verifies each is the mailbox or an alias delivering to it. */
    senderIdentities: z.array(McpMailboxAddressSchema).max(20).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one field must be provided',
  });
export type UpdateMcpConnectionRequest = z.infer<typeof UpdateMcpConnectionRequestSchema>;

export const UpdateMcpCredentialsRequestSchema = z.object({
  mailboxPassword: McpMailboxCredentialPasswordSchema,
});
export type UpdateMcpCredentialsRequest = z.infer<typeof UpdateMcpCredentialsRequestSchema>;

export const McpCredentialIssueResponseSchema = z.object({
  connection: McpConnectionDetailSchema,
  oneTimeCredential: McpOneTimeCredentialSchema,
});
export type McpCredentialIssueResponse = z.infer<typeof McpCredentialIssueResponseSchema>;

export const McpConnectionTestResultSchema = z.object({
  imap: z.object({
    ok: z.boolean(),
    message: z.string(),
    folderCount: z.number().int().nonnegative().nullable(),
  }),
  smtp: z.object({ ok: z.boolean(), message: z.string() }),
  testedAt: z.string(),
});
export type McpConnectionTestResult = z.infer<typeof McpConnectionTestResultSchema>;

export const McpConnectionTestResponseSchema = z.object({
  result: McpConnectionTestResultSchema,
  connection: McpConnectionDetailSchema,
});
export type McpConnectionTestResponse = z.infer<typeof McpConnectionTestResponseSchema>;

export const McpRevokeRequestSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});
export type McpRevokeRequest = z.infer<typeof McpRevokeRequestSchema>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const McpAuditEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  connectionId: z.string().nullable(),
  mailbox: z.string().nullable(),
  actor: z.string(),
  event: z.string(),
  result: z.enum(['success', 'failure']),
  ip: z.string().nullable(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type McpAuditEvent = z.infer<typeof McpAuditEventSchema>;

export const McpAuditListResponseSchema = z.object({
  events: z.array(McpAuditEventSchema),
});
export type McpAuditListResponse = z.infer<typeof McpAuditListResponseSchema>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const McpStatusCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  disabled: z.number().int().nonnegative(),
  suspended: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  revoked: z.number().int().nonnegative(),
});
export type McpStatusCounts = z.infer<typeof McpStatusCountsSchema>;

export const McpServiceStatusSchema = z.object({
  version: z.string(),
  controlProtocolVersion: z.number().int(),
  uptimeSeconds: z.number().nonnegative(),
  enabled: z.boolean(),
  publicBaseUrl: z.string().nullable(),
  issuer: z.string().nullable(),
  vault: z.enum(['ok', 'missing_key', 'key_mismatch']),
  mailBackend: z.enum(['imap', 'fake']),
  counts: McpStatusCountsSchema,
  recentEvents: z.array(McpAuditEventSchema),
  recentFailures: z.array(McpAuditEventSchema),
});
export type McpServiceStatus = z.infer<typeof McpServiceStatusSchema>;

/** Admin server → SPA. `deployed: false` when the integration is not enabled (MCP_ENABLED off). */
export const McpStatusResponseSchema = z.object({
  deployed: z.boolean(),
  /** Why the service is not usable, in operator language — `null` when it is. */
  reason: z.string().nullable(),
  service: McpServiceStatusSchema.nullable(),
});
export type McpStatusResponse = z.infer<typeof McpStatusResponseSchema>;

export const McpDiscoveryCheckItemSchema = z.object({
  check: z.string(),
  ok: z.boolean(),
  message: z.string(),
});
export const McpDiscoveryCheckResponseSchema = z.object({
  checks: z.array(McpDiscoveryCheckItemSchema),
  checkedAt: z.string(),
});
export type McpDiscoveryCheckResponse = z.infer<typeof McpDiscoveryCheckResponseSchema>;

// ---------------------------------------------------------------------------
// Per-mailbox view (mailbox detail page)
// ---------------------------------------------------------------------------

export const McpMailboxOverviewResponseSchema = z.object({
  binding: McpBindingSummarySchema.nullable(),
  connections: z.array(McpConnectionSummarySchema),
});
export type McpMailboxOverviewResponse = z.infer<typeof McpMailboxOverviewResponseSchema>;

// ---------------------------------------------------------------------------
// Control-plane-only shapes (admin server → apps/mcp). Never exposed to the SPA.
// ---------------------------------------------------------------------------

export const McpControlCreateConnectionRequestSchema = z.object({
  mailbox: McpMailboxAddressSchema,
  mailboxFingerprint: McpMailboxFingerprintSchema,
  label: McpConnectionLabelSchema,
  permissions: McpScopeListSchema,
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  mailboxPassword: McpMailboxCredentialPasswordSchema.optional(),
  /** Identity of the postmaster performing the action, for the MCP-side audit trail. */
  actor: z.string().min(1).max(254),
});
export type McpControlCreateConnectionRequest = z.infer<
  typeof McpControlCreateConnectionRequestSchema
>;

export const McpControlUpdateCredentialsRequestSchema = z.object({
  mailboxPassword: McpMailboxCredentialPasswordSchema,
  mailboxFingerprint: McpMailboxFingerprintSchema,
  actor: z.string().min(1).max(254),
});
export type McpControlUpdateCredentialsRequest = z.infer<
  typeof McpControlUpdateCredentialsRequestSchema
>;

export const McpControlActorRequestSchema = z.object({
  actor: z.string().min(1).max(254),
  reason: z.string().trim().max(200).optional(),
});
export type McpControlActorRequest = z.infer<typeof McpControlActorRequestSchema>;

export const McpControlUpdateConnectionRequestSchema = z.object({
  actor: z.string().min(1).max(254),
  label: McpConnectionLabelSchema.optional(),
  permissions: McpScopeListSchema.optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  senderIdentities: z.array(McpMailboxAddressSchema).max(20).optional(),
});
export type McpControlUpdateConnectionRequest = z.infer<
  typeof McpControlUpdateConnectionRequestSchema
>;

export const McpControlSettingsPatchRequestSchema = z.object({
  actor: z.string().min(1).max(254),
  patch: McpSettingsPatchSchema,
});
export type McpControlSettingsPatchRequest = z.infer<typeof McpControlSettingsPatchRequestSchema>;

export const McpReconcileEntrySchema = z.object({
  mailbox: McpMailboxAddressSchema,
  fingerprint: McpMailboxFingerprintSchema,
});
export const McpControlReconcileRequestSchema = z.object({
  /** The *complete* current mailbox list. Only sent after a successful, issue-free read. */
  mailboxes: z.array(McpReconcileEntrySchema).max(100_000),
});
export type McpControlReconcileRequest = z.infer<typeof McpControlReconcileRequestSchema>;

export const McpControlReconcileResponseSchema = z.object({
  checked: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  restored: z.number().int().nonnegative(),
});
export type McpControlReconcileResponse = z.infer<typeof McpControlReconcileResponseSchema>;

export const MCP_MAILBOX_LIFECYCLE_EVENTS = ['password_changed', 'deleted'] as const;
export const McpControlMailboxEventRequestSchema = z.object({
  mailbox: McpMailboxAddressSchema,
  event: z.enum(MCP_MAILBOX_LIFECYCLE_EVENTS),
  actor: z.string().min(1).max(254),
});
export type McpControlMailboxEventRequest = z.infer<typeof McpControlMailboxEventRequestSchema>;

export const McpControlMailboxEventResponseSchema = z.object({
  affectedConnections: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Connection package (what the postmaster hands to the mailbox owner)
// ---------------------------------------------------------------------------

export interface McpConnectionPackageInput {
  readonly mcpUrl: string;
  readonly mailbox: string;
  readonly username: string;
  readonly setupPassword: string;
  readonly permissions: readonly McpScope[];
  readonly expiresAt: string;
}

/** Plain-text connection details — URL, identity, the one-time password, permissions, expiry. */
export function buildMcpConnectionDetailsText(input: McpConnectionPackageInput): string {
  const permissions = input.permissions.map((scope) => `  - ${MCP_SCOPE_LABELS[scope]}`);
  return [
    'MCP connection for ' + input.mailbox,
    '',
    'MCP server URL:  ' + input.mcpUrl,
    'MCP username:    ' + input.username,
    'Setup password:  ' + input.setupPassword,
    '',
    'Permissions:',
    ...permissions,
    '',
    'The setup password works once and expires at ' + input.expiresAt + ' (UTC).',
    'It is not your email password. Do not share it.',
  ].join('\n');
}

/** Step-by-step setup instructions that accompany the details. Contains no secret. */
export function buildMcpSetupInstructionsText(
  input: Pick<McpConnectionPackageInput, 'mcpUrl' | 'mailbox'>,
): string {
  return [
    'Connecting ChatGPT to ' + input.mailbox,
    '',
    '1. In ChatGPT, open Settings → Apps & Connectors (custom MCP connectors must be',
    '   available on your ChatGPT plan/workspace; write actions may require a workspace',
    '   admin to allow them).',
    '2. Create a new connector, paste this MCP server URL, and choose OAuth authentication:',
    '   ' + input.mcpUrl,
    '3. ChatGPT opens a sign-in page served by your mail server. Check that it shows',
    '   ' + input.mailbox + ', then enter the MCP username and setup password you were given.',
    '4. Review the requested permissions and choose Authorize.',
    '5. Back in ChatGPT, the connector is ready. The setup password is now used up;',
    '   if you ever need to connect again, ask your postmaster for new setup credentials.',
    '',
    'Never enter your email password into ChatGPT. Email content shown to ChatGPT is',
    'untrusted: do not let instructions inside an email change what you asked for.',
  ].join('\n');
}
