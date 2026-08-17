/**
 * Zod schemas for DNS diagnostics, DKIM and TLS (M8 — FEATURE_MATRIX.md
 * §10 DNS/MX/SPF/DKIM/DMARC, §11 DKIM generation, §12 TLS/SSL). Same
 * artifact backs server-side validation and client-side types
 * (ARCHITECTURE.md §3), mirroring `mail.ts`'s shape.
 *
 * Two rules from FEATURE_MATRIX.md/SECURITY.md shape everything below:
 *
 *  - **Five DNS states, `unknown` is grey not yellow.** A resolver
 *    failure ("we could not check") must never be indistinguishable from
 *    an actual problem ("we checked, and it's wrong") — conflating the
 *    two trains admins to ignore warnings (§10, SECURITY.md §3.4).
 *  - **No private key ever appears in any schema here.** DKIM schemas
 *    carry only the public DNS record; TLS schemas carry only parsed
 *    certificate (public) fields — there is no `privateKey` field
 *    anywhere in this file, on purpose (FEATURE_MATRIX.md §11, §12).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared DNS vocabulary
// ---------------------------------------------------------------------------

/**
 * `unknown` means "could not check" (resolver timeout/SERVFAIL/network
 * error) — rendered grey, never yellow. `missing` means "checked
 * successfully; nothing is there." `invalid` means "checked successfully;
 * something is there and it's wrong." These three must never be conflated
 * (FEATURE_MATRIX.md §10).
 */
export const DNS_RECORD_STATES = ['detected', 'valid', 'invalid', 'missing', 'unknown'] as const;
export type DnsRecordState = (typeof DNS_RECORD_STATES)[number];
export const DnsRecordStateSchema = z.enum(DNS_RECORD_STATES);

export const DNS_ISSUE_SEVERITIES = ['error', 'warning', 'info'] as const;
export type DnsIssueSeverity = (typeof DNS_ISSUE_SEVERITIES)[number];

export const DnsIssueSchema = z.object({
  severity: z.enum(DNS_ISSUE_SEVERITIES),
  message: z.string(),
});
export type DnsIssue = z.infer<typeof DnsIssueSchema>;

/**
 * Early client-side feedback only, matching `mail.ts`'s
 * `QUOTA_VALUE_PATTERN` convention — the server-side hostname validator
 * (`drivers/dns/hostname.ts`) is authoritative and is what actually gates
 * the SSRF-sensitive resolver call (SECURITY.md §3.4).
 */
export const DNS_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-zA-Z0-9¡-￿](?:[a-zA-Z0-9¡-￿-]{0,61}[a-zA-Z0-9¡-￿])?(?:\.[a-zA-Z0-9¡-￿](?:[a-zA-Z0-9¡-￿-]{0,61}[a-zA-Z0-9¡-￿])?)+$/;
export const DnsHostnameSchema = z
  .string()
  .regex(DNS_HOSTNAME_PATTERN, 'must be a valid domain name, e.g. "example.com"');

// ---------------------------------------------------------------------------
// MX
// ---------------------------------------------------------------------------

export const MxRecordEntrySchema = z.object({
  exchange: z.string(),
  priority: z.number().int(),
});
export type MxRecordEntry = z.infer<typeof MxRecordEntrySchema>;

export const MxCheckSchema = z.object({
  state: DnsRecordStateSchema,
  records: z.array(MxRecordEntrySchema),
  issues: z.array(DnsIssueSchema),
});
export type MxCheck = z.infer<typeof MxCheckSchema>;

// ---------------------------------------------------------------------------
// SPF — validation beyond presence (FEATURE_MATRIX.md §10): multiple
// records, >10 lookups, ~all vs -all.
// ---------------------------------------------------------------------------

export const SPF_ALL_QUALIFIERS = ['~all', '-all', '+all', '?all', 'none'] as const;
export type SpfAllQualifier = (typeof SPF_ALL_QUALIFIERS)[number];

export const SpfCheckSchema = z.object({
  state: DnsRecordStateSchema,
  /** The single `v=spf1` record, when exactly one was found. */
  record: z.string().nullable(),
  /** Every `v=spf1` TXT record found at the domain — length > 1 is itself an RFC 7208 violation. */
  allRecords: z.array(z.string()),
  /** Count of lookup-consuming mechanisms (`a`, `mx`, `include`, `exists`, `redirect`) across the resolved chain; `null` when it could not be confidently counted (e.g. a lookup failed mid-chain). */
  lookupCount: z.number().int().nonnegative().nullable(),
  allQualifier: z.enum(SPF_ALL_QUALIFIERS).nullable(),
  issues: z.array(DnsIssueSchema),
});
export type SpfCheck = z.infer<typeof SpfCheckSchema>;

// ---------------------------------------------------------------------------
// DKIM — the DNS-side presence/shape check. Generation/rotation (§11) is
// a separate concern below, driven by the DMS driver, not the resolver.
// ---------------------------------------------------------------------------

export const DkimDnsCheckSchema = z.object({
  state: DnsRecordStateSchema,
  selector: z.string(),
  record: z.string().nullable(),
  issues: z.array(DnsIssueSchema),
});
export type DkimDnsCheck = z.infer<typeof DkimDnsCheckSchema>;

// ---------------------------------------------------------------------------
// DMARC — validation beyond presence: p=none, missing rua.
// ---------------------------------------------------------------------------

export const DMARC_POLICIES = ['none', 'quarantine', 'reject'] as const;
export type DmarcPolicy = (typeof DMARC_POLICIES)[number];

export const DmarcCheckSchema = z.object({
  state: DnsRecordStateSchema,
  record: z.string().nullable(),
  policy: z.enum(DMARC_POLICIES).nullable(),
  subdomainPolicy: z.enum(DMARC_POLICIES).nullable(),
  hasRua: z.boolean(),
  pct: z.number().min(0).max(100).nullable(),
  issues: z.array(DnsIssueSchema),
});
export type DmarcCheck = z.infer<typeof DmarcCheckSchema>;

// ---------------------------------------------------------------------------
// PTR / A / AAAA — reverse DNS for the domain's mail-sending addresses.
// ---------------------------------------------------------------------------

export const PtrCheckSchema = z.object({
  state: DnsRecordStateSchema,
  /** Resolved A/AAAA addresses for the domain (or its MX hosts). */
  addresses: z.array(z.string()),
  /** Reverse-lookup hostnames per address, `{}` when none resolved. */
  ptrByAddress: z.record(z.string(), z.array(z.string())),
  issues: z.array(DnsIssueSchema),
});
export type PtrCheck = z.infer<typeof PtrCheckSchema>;

// ---------------------------------------------------------------------------
// Combined report — one domain, every record (UX_ARCHITECTURE.md §6.2
// "Email Authentication").
// ---------------------------------------------------------------------------

export const EmailAuthReportSchema = z.object({
  domain: z.string(),
  checkedAt: z.string(),
  mx: MxCheckSchema,
  spf: SpfCheckSchema,
  dkim: DkimDnsCheckSchema,
  dmarc: DmarcCheckSchema,
  ptr: PtrCheckSchema,
});
export type EmailAuthReport = z.infer<typeof EmailAuthReportSchema>;

export const EmailAuthQuerySchema = z.object({
  /** Defaults to DMS's own default selector (`mail`) server-side when omitted. */
  selector: z.string().optional(),
});
export type EmailAuthQuery = z.infer<typeof EmailAuthQuerySchema>;

// ---------------------------------------------------------------------------
// Propagation — a fixed list of public resolvers, queried individually and
// compared. Never a claim of "global propagation," which is not
// observable (FEATURE_MATRIX.md §10).
// ---------------------------------------------------------------------------

export const PROPAGATION_RECORD_TYPES = [
  'MX',
  'TXT_SPF',
  'TXT_DKIM',
  'TXT_DMARC',
  'A',
  'AAAA',
] as const;
export type PropagationRecordType = (typeof PROPAGATION_RECORD_TYPES)[number];

export const PropagationResultSchema = z.object({
  resolverName: z.string(),
  resolverAddress: z.string(),
  state: DnsRecordStateSchema,
  values: z.array(z.string()),
  error: z.string().nullable(),
});
export type PropagationResult = z.infer<typeof PropagationResultSchema>;

export const PropagationReportSchema = z.object({
  domain: z.string(),
  recordType: z.enum(PROPAGATION_RECORD_TYPES),
  checkedAt: z.string(),
  results: z.array(PropagationResultSchema),
  /** Always present so the UI can state the caveat verbatim rather than composing it client-side. */
  caveat: z.string(),
});
export type PropagationReport = z.infer<typeof PropagationReportSchema>;

export const PropagationQuerySchema = z.object({
  recordType: z.enum(PROPAGATION_RECORD_TYPES),
  selector: z.string().optional(),
});
export type PropagationQuery = z.infer<typeof PropagationQuerySchema>;

// ---------------------------------------------------------------------------
// DKIM generation / rotation (FEATURE_MATRIX.md §11). Generation and
// status reads flow through the DMS driver (`setup config dkim`,
// zone-file `.txt` read) — never the `.private` key file.
// ---------------------------------------------------------------------------

export const DKIM_KEYSIZES = [1024, 2048, 4096] as const;
export const DkimKeysizeSchema = z.union([z.literal(1024), z.literal(2048), z.literal(4096)]);
export type DkimKeysize = z.infer<typeof DkimKeysizeSchema>;

/** The DNS TXT record an admin publishes — public data only, safe to render and copy. */
export const DkimPublicRecordSchema = z.object({
  /** e.g. `mail._domainkey.example.com` */
  name: z.string(),
  /** e.g. `v=DKIM1; h=sha256; k=rsa; p=...` — ready to paste as the TXT value. */
  value: z.string(),
});
export type DkimPublicRecord = z.infer<typeof DkimPublicRecordSchema>;

export const DkimStatusSchema = z.object({
  domain: z.string(),
  selector: z.string(),
  keysize: DkimKeysizeSchema.nullable(),
  /** `null` when no key has been generated for this domain/selector yet. */
  publicRecord: DkimPublicRecordSchema.nullable(),
  /** `null` until a DNS check has been run for this selector. */
  dnsCheck: DkimDnsCheckSchema.nullable(),
  /** `true`/`false` once both sides are known; `null` when either side is unavailable (never guessed). */
  matchesDns: z.boolean().nullable(),
});
export type DkimStatus = z.infer<typeof DkimStatusSchema>;

/** `domain` is not repeated here — it is always the `:domain` URL parameter, matching `ChangeMailboxPasswordRequestSchema`'s convention of not re-carrying an identifier the route already has. */
export const GenerateDkimRequestSchema = z.object({
  selector: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, numbers, "-" and "_" only')
    .optional(),
  keysize: DkimKeysizeSchema.optional(),
});
export type GenerateDkimRequest = z.infer<typeof GenerateDkimRequestSchema>;

export const DkimStatusResponseSchema = z.object({ status: DkimStatusSchema });
export type DkimStatusResponse = z.infer<typeof DkimStatusResponseSchema>;

export const DkimQuerySchema = z.object({ selector: z.string().optional() });
export type DkimQuery = z.infer<typeof DkimQuerySchema>;

// ---------------------------------------------------------------------------
// TLS (FEATURE_MATRIX.md §12). Only ever carries parsed *certificate*
// (public) fields — no private key field exists anywhere below.
// ---------------------------------------------------------------------------

export const CERTIFICATE_HEALTH_STATES = ['healthy', 'warning', 'critical', 'unknown'] as const;
export type CertificateHealthState = (typeof CERTIFICATE_HEALTH_STATES)[number];
export const CertificateHealthStateSchema = z.enum(CERTIFICATE_HEALTH_STATES);

export const CertificateInfoSchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  subjectAltNames: z.array(z.string()),
  validFrom: z.string(),
  validTo: z.string(),
  daysRemaining: z.number().int(),
  fingerprint256: z.string(),
  serialNumber: z.string(),
  isSelfSigned: z.boolean(),
});
export type CertificateInfo = z.infer<typeof CertificateInfoSchema>;

export const TLS_ENDPOINT_PROTOCOLS = [
  'smtp-starttls',
  'submission-starttls',
  'smtps',
  'imaps',
  'pop3s',
] as const;
export type TlsEndpointProtocol = (typeof TLS_ENDPOINT_PROTOCOLS)[number];

export const TlsEndpointResultSchema = z.object({
  protocol: z.enum(TLS_ENDPOINT_PROTOCOLS),
  port: z.number().int(),
  label: z.string(),
  reachable: z.boolean(),
  certificate: CertificateInfoSchema.nullable(),
  health: CertificateHealthStateSchema,
  /** Human-readable, safe-to-show reason when `reachable` is false or `health` is `unknown`. */
  error: z.string().nullable(),
});
export type TlsEndpointResult = z.infer<typeof TlsEndpointResultSchema>;

export const TlsStatusResponseSchema = z.object({
  /** Raw `SSL_TYPE` env value from the DMS deployment (`letsencrypt`/`manual`/`self-signed`/`custom`), `null` when unset. */
  sslType: z.string().nullable(),
  checkedAt: z.string(),
  endpoints: z.array(TlsEndpointResultSchema),
  /** Fixed documentation link for wiring an external ACME client — Let's Encrypt issuance is never performed by this panel (FEATURE_MATRIX.md §12). */
  acmeDocsHref: z.string(),
});
export type TlsStatusResponse = z.infer<typeof TlsStatusResponseSchema>;
