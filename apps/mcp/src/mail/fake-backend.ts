/**
 * In-memory mail backend — a test double for development and the browser
 * E2E suite only (config.ts refuses it in production). It honours the same
 * isolation contract as the real backend: storage is keyed by the bound
 * `account.address`, so one mailbox's data is unreachable from another's
 * context. Seeded content is clearly synthetic.
 */
import {
  MailError,
  type AttachmentContent,
  type FullMessage,
  type MailAccountContext,
  type MailBackend,
  type MailFolder,
  type MessageListPage,
  type MessageRef,
  type OutgoingMessage,
  type SearchCriteria,
  type SendResult,
  type TrashMove,
  type VerifyResult,
} from './types.js';

interface FakeMessage {
  uid: number;
  subject: string;
  from: string;
  to: string[];
  date: string;
  seen: boolean;
  body: string;
  messageId: string;
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
}

interface FakeFolder {
  readonly path: string;
  readonly specialUse: string | null;
  readonly uidValidity: string;
  nextUid: number;
  messages: FakeMessage[];
}

interface FakeMailboxState {
  folders: Map<string, FakeFolder>;
}

export interface FakeMailBackendOptions {
  /** When set, only these address→password pairs authenticate. Otherwise any non-empty password works except "wrong-password". */
  readonly passwords?: ReadonlyMap<string, string>;
  /** Seed each new mailbox with a few synthetic messages. */
  readonly seed?: boolean;
}

export class FakeMailBackend implements MailBackend {
  readonly kind = 'fake' as const;
  private readonly mailboxes = new Map<string, FakeMailboxState>();
  readonly sent: Array<{ account: string; message: OutgoingMessage }> = [];

  constructor(private readonly options: FakeMailBackendOptions = {}) {}

  private authenticate(account: MailAccountContext): void {
    const expected = this.options.passwords?.get(account.address);
    const ok =
      this.options.passwords !== undefined
        ? expected !== undefined && expected === account.password
        : account.password.length > 0 && account.password !== 'wrong-password';
    if (!ok) throw new MailError('auth_failed', 'The mail server rejected the mailbox credential.');
  }

  /** Test helper: the state for one address (created on demand). */
  state(address: string): FakeMailboxState {
    let state = this.mailboxes.get(address);
    if (state === undefined) {
      state = { folders: new Map() };
      for (const [path, specialUse] of [
        ['INBOX', null],
        ['Sent', '\\Sent'],
        ['Trash', '\\Trash'],
        ['Drafts', '\\Drafts'],
      ] as const) {
        state.folders.set(path, {
          path,
          specialUse,
          uidValidity: String(1700000000 + state.folders.size),
          nextUid: 1,
          messages: [],
        });
      }
      this.mailboxes.set(address, state);
      if (this.options.seed !== false) {
        const inbox = state.folders.get('INBOX')!;
        this.deliver(address, inbox, {
          subject: `Welcome to ${address}`,
          from: 'postmaster@example.test',
          body: `This synthetic message exists only in the development fake mail backend for ${address}.`,
        });
        this.deliver(address, inbox, {
          subject: 'Quarterly report draft',
          from: 'colleague@example.test',
          body: 'Synthetic test message with an attachment.',
          attachments: [
            {
              filename: 'report.txt',
              contentType: 'text/plain',
              content: Buffer.from('synthetic attachment'),
            },
          ],
        });
      }
    }
    return state;
  }

  /** Test helper: deliver a message into a folder of `address`. */
  deliver(
    address: string,
    folder: FakeFolder | string,
    input: {
      subject: string;
      from: string;
      body: string;
      seen?: boolean;
      attachments?: FakeMessage['attachments'];
    },
  ): FakeMessage {
    const target = typeof folder === 'string' ? this.state(address).folders.get(folder) : folder;
    if (target === undefined) throw new Error(`no folder ${String(folder)}`);
    const message: FakeMessage = {
      uid: target.nextUid++,
      subject: input.subject,
      from: input.from,
      to: [address],
      date: new Date(Date.UTC(2026, 0, 1, 12, target.nextUid)).toISOString(),
      seen: input.seen ?? false,
      body: input.body,
      messageId: `<fake-${address}-${target.path}-${target.nextUid}@example.test>`,
      attachments: input.attachments ?? [],
    };
    target.messages.push(message);
    return message;
  }

  private folder(account: MailAccountContext, path: string): FakeFolder {
    const folder = this.state(account.address).folders.get(path);
    if (folder === undefined)
      throw new MailError('not_found', 'That folder does not exist in this mailbox.');
    return folder;
  }

  private locate(
    account: MailAccountContext,
    ref: MessageRef,
  ): { folder: FakeFolder; message: FakeMessage } {
    const folder = this.folder(account, ref.folder);
    if (folder.uidValidity !== ref.uidValidity)
      throw new MailError(
        'stale_reference',
        'This message reference is out of date; list the folder again.',
      );
    const message = folder.messages.find((m) => m.uid === ref.uid);
    if (message === undefined) throw new MailError('not_found', 'That message no longer exists.');
    return { folder, message };
  }

  async verify(account: MailAccountContext): Promise<VerifyResult> {
    try {
      this.authenticate(account);
      return {
        imap: {
          ok: true,
          message: 'IMAP login succeeded (fake backend).',
          folderCount: this.state(account.address).folders.size,
          authFailed: false,
        },
        smtp: {
          ok: true,
          message: 'SMTP authentication succeeded (fake backend).',
          authFailed: false,
        },
      };
    } catch {
      return {
        imap: {
          ok: false,
          message: 'The mail server rejected the mailbox credential.',
          folderCount: null,
          authFailed: true,
        },
        smtp: {
          ok: false,
          message: 'The mail server rejected the mailbox credential for SMTP.',
          authFailed: true,
        },
      };
    }
  }

  async listFolders(account: MailAccountContext): Promise<MailFolder[]> {
    this.authenticate(account);
    return [...this.state(account.address).folders.values()].map((folder) => ({
      path: folder.path,
      name: folder.path,
      specialUse: folder.specialUse,
      messages: folder.messages.length,
      unseen: folder.messages.filter((m) => !m.seen).length,
    }));
  }

  private page(
    folder: FakeFolder,
    messages: FakeMessage[],
    limit: number,
    beforeUid: number | null,
  ): MessageListPage {
    const sorted = messages
      .filter((m) => beforeUid === null || m.uid < beforeUid)
      .sort((a, b) => b.uid - a.uid);
    const page = sorted.slice(0, limit);
    const last = page[page.length - 1];
    return {
      folder: folder.path,
      uidValidity: folder.uidValidity,
      messages: page.map((m) => ({
        ref: { folder: folder.path, uidValidity: folder.uidValidity, uid: m.uid },
        subject: m.subject,
        from: [{ name: null, address: m.from }],
        to: m.to.map((address) => ({ name: null, address })),
        date: m.date,
        seen: m.seen,
        flagged: false,
        size: m.body.length,
        hasAttachments: m.attachments.length > 0,
      })),
      nextBeforeUid: sorted.length > page.length && last !== undefined ? last.uid : null,
    };
  }

  async listMessages(
    account: MailAccountContext,
    options: { folder: string; limit: number; beforeUid: number | null; unreadOnly: boolean },
  ): Promise<MessageListPage> {
    this.authenticate(account);
    const folder = this.folder(account, options.folder);
    return this.page(
      folder,
      folder.messages.filter((m) => !options.unreadOnly || !m.seen),
      options.limit,
      options.beforeUid,
    );
  }

  async search(
    account: MailAccountContext,
    options: { folder: string; criteria: SearchCriteria; limit: number; beforeUid: number | null },
  ): Promise<MessageListPage> {
    this.authenticate(account);
    const folder = this.folder(account, options.folder);
    const c = options.criteria;
    const has = (haystack: string, needle: string | undefined) =>
      needle === undefined || haystack.toLowerCase().includes(needle.toLowerCase());
    const matches = folder.messages.filter(
      (m) =>
        has(`${m.subject}\n${m.body}\n${m.from}`, c.text) &&
        has(m.from, c.from) &&
        has(m.to.join(','), c.to) &&
        has(m.subject, c.subject) &&
        (c.unreadOnly !== true || !m.seen) &&
        (c.since === undefined || m.date >= new Date(c.since).toISOString()) &&
        (c.before === undefined || m.date < new Date(c.before).toISOString()),
    );
    return this.page(folder, matches, options.limit, options.beforeUid);
  }

  async getMessage(
    account: MailAccountContext,
    ref: MessageRef,
    options: { maxBodyChars: number },
  ): Promise<FullMessage> {
    this.authenticate(account);
    const { folder, message } = this.locate(account, ref);
    const truncated = message.body.length > options.maxBodyChars;
    return {
      ref: { folder: folder.path, uidValidity: folder.uidValidity, uid: message.uid },
      subject: message.subject,
      from: [{ name: null, address: message.from }],
      to: message.to.map((address) => ({ name: null, address })),
      cc: [],
      replyTo: [],
      date: message.date,
      seen: message.seen,
      flagged: false,
      size: message.body.length,
      hasAttachments: message.attachments.length > 0,
      messageId: message.messageId,
      inReplyTo: null,
      references: null,
      bodyText: truncated ? message.body.slice(0, options.maxBodyChars) : message.body,
      bodyTruncated: truncated,
      hadHtml: false,
      attachments: message.attachments.map((a, index) => ({
        attachmentId: `a${index}`,
        filename: a.filename,
        contentType: a.contentType,
        size: a.content.length,
      })),
    };
  }

  async getAttachment(
    account: MailAccountContext,
    ref: MessageRef,
    attachmentId: string,
    maxBytes: number,
  ): Promise<AttachmentContent> {
    this.authenticate(account);
    const { message } = this.locate(account, ref);
    const index = /^a(\d{1,3})$/.exec(attachmentId)?.[1];
    const attachment = index === undefined ? undefined : message.attachments[Number(index)];
    if (attachment === undefined)
      throw new MailError('not_found', 'That attachment does not exist on this message.');
    if (attachment.content.length > maxBytes)
      throw new MailError('too_large', 'That attachment exceeds the size limit.');
    return {
      meta: {
        attachmentId,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.content.length,
      },
      data: attachment.content,
    };
  }

  async moveToTrash(
    account: MailAccountContext,
    refs: readonly MessageRef[],
  ): Promise<TrashMove[]> {
    this.authenticate(account);
    const trash = this.folder(account, 'Trash');
    const located = refs.map((ref) => {
      if (ref.folder === trash.path)
        throw new MailError(
          'invalid',
          'These messages are already in Trash; permanent deletion is not supported.',
        );
      return { ref, ...this.locate(account, ref) };
    });
    return located.map(({ ref, folder, message }) => {
      folder.messages = folder.messages.filter((m) => m !== message);
      const moved = { ...message, uid: trash.nextUid++ };
      trash.messages.push(moved);
      return {
        original: ref,
        trash: { folder: trash.path, uidValidity: trash.uidValidity, uid: moved.uid },
        messageId: message.messageId,
      };
    });
  }

  async restoreFromTrash(
    account: MailAccountContext,
    from: MessageRef,
    toFolder: string,
    expectedMessageId: string | null,
  ): Promise<MessageRef> {
    this.authenticate(account);
    const target = this.folder(account, toFolder);
    const { folder, message } = this.locate(account, from);
    if (expectedMessageId !== null && message.messageId !== expectedMessageId) {
      throw new MailError(
        'stale_reference',
        'The message in Trash does not match the one that was deleted.',
      );
    }
    folder.messages = folder.messages.filter((m) => m !== message);
    const restored = { ...message, uid: target.nextUid++ };
    target.messages.push(restored);
    return { folder: target.path, uidValidity: target.uidValidity, uid: restored.uid };
  }

  async send(
    account: MailAccountContext,
    message: OutgoingMessage,
    options: { saveToSent: boolean },
  ): Promise<SendResult> {
    this.authenticate(account);
    this.sent.push({ account: account.address, message });
    if (options.saveToSent) {
      const sent = this.folder(account, 'Sent');
      sent.messages.push({
        uid: sent.nextUid++,
        subject: message.subject,
        from: message.from.address,
        to: [...message.to],
        date: new Date().toISOString(),
        seen: true,
        body: message.text ?? '',
        messageId: message.messageId,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content,
        })),
      });
    }
    return {
      accepted: [...message.to, ...message.cc, ...message.bcc],
      rejected: [],
      response: '250 2.0.0 Ok: queued (fake backend)',
      savedToSent: options.saveToSent,
      sentFolderError: null,
    };
  }
}
