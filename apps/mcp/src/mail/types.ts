/**
 * The mail-access port every MCP tool is built on. Two implementations:
 *
 *  - `ImapSmtpMailBackend` (mail/imap-smtp-backend.ts) — real IMAP (imapflow)
 *    and SMTP (nodemailer) over TLS, authenticating as exactly one mailbox
 *    with the credential the postmaster provisioned. This is the only
 *    backend production will run (config.ts refuses `fake` there).
 *  - `FakeMailBackend` (mail/fake-backend.ts) — an in-memory test double for
 *    development and the browser E2E suite, mirroring how apps/server binds
 *    fake drivers in development (ARCHITECTURE.md §9).
 *
 * The port has **no mailbox parameter that a tool can influence**: every
 * method takes a {@link MailAccountContext} that the MCP layer builds
 * server-side from the validated OAuth context (connection → binding →
 * decrypted credential). There is no code path from tool arguments to the
 * `address` field.
 */
import type { McpMailSettings } from '@dwg/shared';

export interface MailAccountContext {
  /** The bound mailbox. Comes from the binding row, never from a request. */
  readonly address: string;
  readonly password: string;
  readonly transport: McpMailSettings;
}

export interface VerifyResult {
  readonly imap: {
    readonly ok: boolean;
    readonly message: string;
    readonly folderCount: number | null;
    readonly authFailed: boolean;
  };
  readonly smtp: { readonly ok: boolean; readonly message: string; readonly authFailed: boolean };
}

export interface MailFolder {
  readonly path: string;
  readonly name: string;
  readonly specialUse: string | null;
  readonly messages: number | null;
  readonly unseen: number | null;
}

/** Identifies one message: folder + UIDVALIDITY + UID (RFC 3501 §2.3.1.1). */
export interface MessageRef {
  readonly folder: string;
  readonly uidValidity: string;
  readonly uid: number;
}

export interface MailAddress {
  readonly name: string | null;
  readonly address: string | null;
}

export interface MessageSummary {
  readonly ref: MessageRef;
  readonly subject: string | null;
  readonly from: readonly MailAddress[];
  readonly to: readonly MailAddress[];
  readonly date: string | null;
  readonly seen: boolean;
  readonly flagged: boolean;
  readonly size: number | null;
  readonly hasAttachments: boolean;
}

export interface MessageListPage {
  readonly folder: string;
  readonly uidValidity: string;
  readonly messages: readonly MessageSummary[];
  /** UID to pass as `beforeUid` for the next (older) page, or `null` when exhausted. */
  readonly nextBeforeUid: number | null;
}

export interface AttachmentMeta {
  readonly attachmentId: string;
  readonly filename: string | null;
  readonly contentType: string;
  readonly size: number | null;
}

export interface FullMessage extends MessageSummary {
  readonly cc: readonly MailAddress[];
  readonly replyTo: readonly MailAddress[];
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
  /** Plain-text body (HTML converted to text if there was no text part), truncated to the requested size. */
  readonly bodyText: string;
  readonly bodyTruncated: boolean;
  readonly hadHtml: boolean;
  readonly attachments: readonly AttachmentMeta[];
}

export interface AttachmentContent {
  readonly meta: AttachmentMeta;
  readonly data: Buffer;
}

export interface SearchCriteria {
  readonly text?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly subject?: string | undefined;
  readonly since?: string | undefined;
  readonly before?: string | undefined;
  readonly unreadOnly?: boolean | undefined;
}

export interface TrashMove {
  readonly original: MessageRef;
  readonly trash: MessageRef;
  readonly messageId: string | null;
}

export interface OutgoingAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface OutgoingMessage {
  readonly from: { readonly name: string | null; readonly address: string };
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
  readonly attachments: readonly OutgoingAttachment[];
  /** Pre-assigned Message-ID so a retried/uncertain send is traceable. */
  readonly messageId: string;
}

export interface SendResult {
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly response: string;
  readonly savedToSent: boolean;
  readonly sentFolderError: string | null;
}

/** Thrown for failures the caller should map to a user-safe message. */
export class MailError extends Error {
  constructor(
    readonly kind:
      | 'auth_failed'
      | 'unavailable'
      | 'not_found'
      | 'stale_reference'
      | 'invalid'
      | 'too_large'
      | 'send_uncertain'
      | 'send_rejected',
    message: string,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

export interface MailBackend {
  readonly kind: 'imap' | 'fake';
  verify(account: MailAccountContext): Promise<VerifyResult>;
  listFolders(account: MailAccountContext): Promise<MailFolder[]>;
  listMessages(
    account: MailAccountContext,
    options: {
      readonly folder: string;
      readonly limit: number;
      readonly beforeUid: number | null;
      readonly unreadOnly: boolean;
    },
  ): Promise<MessageListPage>;
  search(
    account: MailAccountContext,
    options: {
      readonly folder: string;
      readonly criteria: SearchCriteria;
      readonly limit: number;
      readonly beforeUid: number | null;
    },
  ): Promise<MessageListPage>;
  getMessage(
    account: MailAccountContext,
    ref: MessageRef,
    options: { readonly maxBodyChars: number; readonly maxMessageBytes: number },
  ): Promise<FullMessage>;
  getAttachment(
    account: MailAccountContext,
    ref: MessageRef,
    attachmentId: string,
    maxBytes: number,
  ): Promise<AttachmentContent>;
  /** Moves each message to the account's Trash folder. Refuses messages already in Trash. */
  moveToTrash(account: MailAccountContext, refs: readonly MessageRef[]): Promise<TrashMove[]>;
  /**
   * Moves a message out of Trash back to `toFolder`, only if `from` still
   * identifies it exactly (same UIDVALIDITY, message present, and — when one
   * was recorded — the same Message-ID header).
   */
  restoreFromTrash(
    account: MailAccountContext,
    from: MessageRef,
    toFolder: string,
    expectedMessageId: string | null,
  ): Promise<MessageRef>;
  send(
    account: MailAccountContext,
    message: OutgoingMessage,
    options: { readonly saveToSent: boolean },
  ): Promise<SendResult>;
}
