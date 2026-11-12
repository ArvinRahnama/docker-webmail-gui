/**
 * Spam filtering beyond Rspamd's own controls (docker/dms/README.md):
 *
 *  - **Sender lists.** Every mailbox has its own allow list and block list
 *    of sender addresses, domains and client IPs. An allowed sender's mail
 *    is never filed in Junk; a blocked sender's always is. Spam is never
 *    rejected either way — the docker-mailserver integration turns
 *    Rspamd's reject off and files spam in Junk instead.
 *  - **Reports.** A user moving a message out of Junk ("not spam") allows
 *    its sender for that mailbox; moving one into Junk ("spam") blocks it.
 *  - **Rejected mail.** What the mail server refused at SMTP time, and why.
 */
import { z } from 'zod';
import { validateAddressForArgv, validateDomain, validateIpAddress } from './dms-validators.js';

export const SENDER_LISTS = ['allow', 'block'] as const;
export type SenderList = (typeof SENDER_LISTS)[number];
export const SenderListSchema = z.enum(SENDER_LISTS);

/** Most specific first — the order entries are matched in at delivery time. */
export const SENDER_ENTRY_KINDS = ['address', 'domain', 'ip'] as const;
export type SenderEntryKind = (typeof SENDER_ENTRY_KINDS)[number];
export const SenderEntryKindSchema = z.enum(SENDER_ENTRY_KINDS);

/** `report`: added because the mailbox's user moved mail into or out of Junk. `admin`: added by an administrator in the panel. */
export const SENDER_ENTRY_SOURCES = ['report', 'admin'] as const;
export type SenderEntrySource = (typeof SENDER_ENTRY_SOURCES)[number];
export const SenderEntrySourceSchema = z.enum(SENDER_ENTRY_SOURCES);

/**
 * Entries per mailbox, both lists together. Bounded by the panel's Sieve
 * script size cap (`sieve-validator.ts`, 32 KiB): each entry appears in the
 * generated script once as data and once or twice as a match value, about
 * 120 bytes in all, so 200 leaves comfortable headroom. When a report would
 * exceed it, the oldest reported entry makes room; entries an
 * administrator added are never evicted.
 */
export const SENDER_LIST_MAX_ENTRIES = 200;

/** Validates `value` as an entry of `kind`, returning `null` when valid. Values are compared lower-cased, so callers normalise first. */
export function validateSenderEntryValue(kind: SenderEntryKind, value: string): string | null {
  switch (kind) {
    case 'address':
      return validateAddressForArgv(value);
    case 'domain':
      return validateDomain(value);
    case 'ip':
      return validateIpAddress(value);
  }
}

export const SenderListEntrySchema = z.object({
  list: SenderListSchema,
  kind: SenderEntryKindSchema,
  value: z.string(),
  source: SenderEntrySourceSchema,
  addedAt: z.string(),
});
export type SenderListEntry = z.infer<typeof SenderListEntrySchema>;

/** Whether the docker-mailserver side (docker/dms/) is installed. Without it, lists are stored but nothing reads them at delivery time, and no reports arrive. */
export const SpamIntegrationStatusSchema = z.object({
  installed: z.boolean(),
  version: z.number().int().nullable(),
});
export type SpamIntegrationStatus = z.infer<typeof SpamIntegrationStatusSchema>;

export const SpamIntegrationResponseSchema = z.object({ integration: SpamIntegrationStatusSchema });
export type SpamIntegrationResponse = z.infer<typeof SpamIntegrationResponseSchema>;

export const SenderListsResponseSchema = z.object({
  mailbox: z.string(),
  integration: SpamIntegrationStatusSchema,
  entries: z.array(SenderListEntrySchema),
  /** A script exists under the reserved name but was not written by the panel (hand-edited); its entries are not shown and the next change replaces it. */
  unrecognisedContent: z.boolean(),
  maxEntries: z.number().int(),
});
export type SenderListsResponse = z.infer<typeof SenderListsResponseSchema>;

const SenderEntryInputBase = z.object({
  list: SenderListSchema,
  kind: SenderEntryKindSchema,
  value: z
    .string()
    .trim()
    .min(1)
    .max(254)
    .transform((value) => value.toLowerCase()),
});

function refineEntryValue(
  entry: { kind: SenderEntryKind; value: string },
  ctx: z.RefinementCtx,
): void {
  const error = validateSenderEntryValue(entry.kind, entry.value);
  if (error !== null) ctx.addIssue({ code: 'custom', path: ['value'], message: error });
}

export const AddSenderListEntryRequestSchema = SenderEntryInputBase.superRefine(refineEntryValue);
export type AddSenderListEntryRequest = z.infer<typeof AddSenderListEntryRequestSchema>;

export const RemoveSenderListEntryRequestSchema =
  SenderEntryInputBase.superRefine(refineEntryValue);
export type RemoveSenderListEntryRequest = z.infer<typeof RemoveSenderListEntryRequestSchema>;

export const SENDER_REPORT_ACTIONS = ['ham', 'spam'] as const;
export type SenderReportAction = (typeof SENDER_REPORT_ACTIONS)[number];

/** One user report, as processed. `list`/`kind`/`value` are what it changed; all three are `null` when it changed nothing (`outcome` says why). */
export const SenderReportSchema = z.object({
  reportedAt: z.string(),
  mailbox: z.string(),
  action: z.enum(SENDER_REPORT_ACTIONS),
  sender: z.string().nullable(),
  clientIp: z.string().nullable(),
  list: SenderListSchema.nullable(),
  kind: SenderEntryKindSchema.nullable(),
  value: z.string().nullable(),
  outcome: z.string(),
});
export type SenderReport = z.infer<typeof SenderReportSchema>;

export const SenderReportsResponseSchema = z.object({ reports: z.array(SenderReportSchema) });
export type SenderReportsResponse = z.infer<typeof SenderReportsResponseSchema>;

// ---------------------------------------------------------------------------
// Rejected mail
// ---------------------------------------------------------------------------

/**
 * Why a message was refused, coarsely. `spam` only ever appears for mail
 * refused before the integration was installed, or by an operator's own
 * Rspamd override — with it installed, spam is filed in Junk instead.
 */
export const REJECTION_CATEGORIES = [
  'spam',
  'virus',
  'recipient',
  'sender',
  'client',
  'policy',
  'other',
] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

export const RejectedMailEntrySchema = z.object({
  at: z.string(),
  /** `postfix`: a reject line in the mail log. `rspamd`: an Rspamd history row (carries the subject and score the log lacks). A milter reject that appears in both is merged into one entry. */
  source: z.enum(['postfix', 'rspamd']),
  category: z.enum(REJECTION_CATEGORIES),
  /** A 4xx refusal: the sending server is told to try again later, so the message may still arrive. */
  temporary: z.boolean(),
  clientIp: z.string().nullable(),
  clientHost: z.string().nullable(),
  from: z.string().nullable(),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  score: z.number().nullable(),
  smtpCode: z.string().nullable(),
  reason: z.string(),
});
export type RejectedMailEntry = z.infer<typeof RejectedMailEntrySchema>;

export const RejectedMailResponseSchema = z.object({
  entries: z.array(RejectedMailEntrySchema),
  /** How far back the list can reach — always stated, so it is never read as a complete history. */
  window: z.string(),
  logAvailable: z.boolean(),
  logError: z.string().nullable(),
  rspamdAvailable: z.boolean(),
});
export type RejectedMailResponse = z.infer<typeof RejectedMailResponseSchema>;
