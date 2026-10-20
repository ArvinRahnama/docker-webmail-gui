/**
 * Real mail access: IMAP via imapflow, SMTP submission via nodemailer.
 *
 * Isolation is structural: each operation opens a fresh IMAP session
 * authenticated as `account.address` with that mailbox's own credential and
 * logs out afterwards. There is no master user, no shared session, no
 * Dovecot impersonation and no route through the Docker broker — the mail
 * server itself enforces that this session can see one mailbox only.
 *
 * Transport security: implicit TLS or *required* STARTTLS (imapflow
 * `doSTARTTLS: true`, nodemailer `requireTLS: true`); TLS ≥ 1.2;
 * certificate verification on unless the postmaster explicitly disabled it.
 * Plain-text transport is not offered at all.
 *
 * Content handling: message sources are fetched with BODY.PEEK (no \Seen
 * side effect), size-checked before download, parsed with postal-mime, and
 * reduced to bounded plain text. Nothing referenced inside a message (images,
 * links, remote stylesheets) is ever fetched.
 */
import { randomBytes } from 'node:crypto';
import {
  ImapFlow,
  type FetchMessageObject,
  type ListResponse,
  type MessageStructureObject,
} from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import PostalMime, { type Address, type Email } from 'postal-mime';
import type { Logger } from 'pino';
import {
  MailError,
  type AttachmentContent,
  type AttachmentMeta,
  type FullMessage,
  type MailAccountContext,
  type MailAddress,
  type MailBackend,
  type MailFolder,
  type MessageListPage,
  type MessageRef,
  type MessageSummary,
  type OutgoingMessage,
  type SearchCriteria,
  type SendResult,
  type TrashMove,
  type VerifyResult,
} from './types.js';
import { cleanLine, htmlToText, stripControlCharacters, truncate } from './text.js';
import { isSafeFolderName } from './message-ref.js';

const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;
/** Per-mailbox ceiling on simultaneous IMAP sessions opened by this service (Dovecot's default per-user/IP limit is 10). */
const MAX_SESSIONS_PER_MAILBOX = 3;

export interface ImapSmtpBackendOptions {
  /** Extra CA bundle (PEM) trusted for the mail server's certificate. */
  readonly tlsCa: string | null;
  readonly logger: Logger;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function toAddresses(
  list: readonly { name?: string | undefined; address?: string | undefined }[] | undefined,
): MailAddress[] {
  return (list ?? []).slice(0, 50).map((entry) => ({
    name: cleanLine(entry.name ?? null, 200) || null,
    address: cleanLine(entry.address ?? null, 254),
  }));
}

function flattenParsed(list: readonly Address[] | Address | undefined): MailAddress[] {
  const input = list === undefined ? [] : Array.isArray(list) ? list : [list];
  const out: MailAddress[] = [];
  for (const entry of input) {
    if (entry.group !== undefined) {
      for (const member of entry.group)
        out.push({
          name: cleanLine(member.name, 200) || null,
          address: cleanLine(member.address, 254),
        });
    } else {
      out.push({
        name: cleanLine(entry.name, 200) || null,
        address: cleanLine(entry.address, 254),
      });
    }
    if (out.length >= 50) break;
  }
  return out;
}

function structureHasAttachment(node: MessageStructureObject | undefined, depth = 0): boolean {
  if (node === undefined || depth > 20) return false;
  if (node.disposition === 'attachment') return true;
  if (
    node.dispositionParameters?.['filename'] !== undefined &&
    node.type !== 'text/plain' &&
    node.type !== 'text/html'
  )
    return true;
  return (node.childNodes ?? []).some((child) => structureHasAttachment(child, depth + 1));
}

function toIso(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summarize(
  folder: string,
  uidValidity: string,
  message: FetchMessageObject,
): MessageSummary {
  return {
    ref: { folder, uidValidity, uid: message.uid },
    subject: cleanLine(message.envelope?.subject ?? null),
    from: toAddresses(message.envelope?.from),
    to: toAddresses(message.envelope?.to),
    date: toIso(message.envelope?.date ?? message.internalDate),
    seen: message.flags?.has('\\Seen') ?? false,
    flagged: message.flags?.has('\\Flagged') ?? false,
    size: message.size ?? null,
    hasAttachments: structureHasAttachment(message.bodyStructure),
  };
}

function classifyImapError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const e = err as {
    authenticationFailed?: boolean;
    code?: string;
    responseText?: string;
    message?: string;
  };
  if (e.authenticationFailed === true)
    return new MailError('auth_failed', 'The mail server rejected the mailbox credential.');
  if (
    e.code === 'CONNECT_TIMEOUT' ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'ECONNREFUSED' ||
    e.code === 'ENOTFOUND' ||
    e.code === 'EHOSTUNREACH'
  ) {
    return new MailError('unavailable', 'The mail server could not be reached.');
  }
  if (typeof e.code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|HOSTNAME/i.test(e.code)) {
    return new MailError('unavailable', 'The mail server’s TLS certificate could not be verified.');
  }
  return new MailError('unavailable', 'The mail server returned an error.');
}

export class ImapSmtpMailBackend implements MailBackend {
  readonly kind = 'imap' as const;
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(private readonly options: ImapSmtpBackendOptions) {}

  private tlsOptions(account: MailAccountContext, host: string) {
    return {
      rejectUnauthorized: account.transport.tlsVerify,
      servername: account.transport.tlsServername ?? host,
      minVersion: 'TLSv1.2' as const,
      ...(this.options.tlsCa !== null ? { ca: this.options.tlsCa } : {}),
    };
  }

  private semaphoreFor(address: string): Semaphore {
    let semaphore = this.semaphores.get(address);
    if (semaphore === undefined) {
      semaphore = new Semaphore(MAX_SESSIONS_PER_MAILBOX);
      this.semaphores.set(address, semaphore);
    }
    return semaphore;
  }

  private newImapClient(account: MailAccountContext): ImapFlow {
    const transport = account.transport;
    return new ImapFlow({
      host: transport.imapHost,
      port: transport.imapPort,
      secure: transport.imapSecurity === 'tls',
      ...(transport.imapSecurity === 'starttls' ? { doSTARTTLS: true } : {}),
      ...(transport.tlsServername !== null ? { servername: transport.tlsServername } : {}),
      auth: { user: account.address, pass: account.password },
      tls: this.tlsOptions(account, transport.imapHost),
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      maxLiteralSize: 64 * 1024 * 1024,
      maxResponseSize: 96 * 1024 * 1024,
      clientInfo: { name: 'docker-webmail-gui-mcp' },
    });
  }

  /** One authenticated session for the bound mailbox, always logged out afterwards. */
  private withImap<T>(
    account: MailAccountContext,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    return this.semaphoreFor(account.address).run(async () => {
      const client = this.newImapClient(account);
      // imapflow emits 'error' on socket failures; an unhandled one would crash the process.
      client.on('error', (err: unknown) => {
        this.options.logger.debug(
          { code: (err as { code?: unknown }).code },
          'imap connection error',
        );
      });
      try {
        await client.connect();
      } catch (err) {
        throw classifyImapError(err);
      }
      try {
        return await fn(client);
      } catch (err) {
        throw classifyImapError(err);
      } finally {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      }
    });
  }

  private async folders(client: ImapFlow): Promise<ListResponse[]> {
    const list = await client.list();
    return list.filter(
      (entry) => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'),
    );
  }

  /** Confirms `folder` is a selectable folder of *this* mailbox; returns its canonical path. */
  private async requireFolder(client: ImapFlow, folder: string): Promise<ListResponse> {
    if (!isSafeFolderName(folder)) throw new MailError('invalid', 'That folder name is not valid.');
    const match = (await this.folders(client)).find(
      (entry) =>
        entry.path === folder ||
        (folder.toUpperCase() === 'INBOX' && entry.path.toUpperCase() === 'INBOX'),
    );
    if (match === undefined)
      throw new MailError('not_found', 'That folder does not exist in this mailbox.');
    return match;
  }

  private async findSpecial(
    client: ImapFlow,
    use: '\\Trash' | '\\Sent',
    fallbackName: string,
  ): Promise<ListResponse | null> {
    const all = await this.folders(client);
    return (
      all.find((entry) => entry.specialUse === use) ??
      all.find((entry) => entry.path.toLowerCase() === fallbackName.toLowerCase()) ??
      null
    );
  }

  // ---------------------------------------------------------------------------

  async verify(account: MailAccountContext): Promise<VerifyResult> {
    let imap: VerifyResult['imap'];
    try {
      const count = await this.withImap(
        account,
        async (client) => (await this.folders(client)).length,
      );
      imap = { ok: true, message: 'IMAP login succeeded.', folderCount: count, authFailed: false };
    } catch (err) {
      const mailErr = classifyImapError(err);
      imap = {
        ok: false,
        message: mailErr.message,
        folderCount: null,
        authFailed: mailErr.kind === 'auth_failed',
      };
    }
    let smtp: VerifyResult['smtp'];
    const transporter = this.smtpTransport(account);
    try {
      await transporter.verify();
      smtp = { ok: true, message: 'SMTP authentication succeeded.', authFailed: false };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; message?: string };
      const authFailed = e.code === 'EAUTH' || e.responseCode === 535;
      const certFailed =
        !authFailed && /certificate|altnames|self[- ]signed/i.test(e.message ?? '');
      smtp = {
        ok: false,
        message: authFailed
          ? 'The mail server rejected the mailbox credential for SMTP.'
          : certFailed
            ? 'The SMTP server’s TLS certificate could not be verified.'
            : 'The SMTP submission server could not be reached or refused TLS.',
        authFailed,
      };
    } finally {
      transporter.close();
    }
    return { imap, smtp };
  }

  async listFolders(account: MailAccountContext): Promise<MailFolder[]> {
    return this.withImap(account, async (client) => {
      const list = await client.list({ statusQuery: { messages: true, unseen: true } });
      return list
        .filter((entry) => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'))
        .slice(0, 500)
        .map((entry) => ({
          path: entry.path,
          name: entry.name,
          specialUse: entry.specialUse ?? null,
          messages: entry.status?.messages ?? null,
          unseen: entry.status?.unseen ?? null,
        }));
    });
  }

  private async pageFromUids(
    client: ImapFlow,
    folder: string,
    uidValidity: string,
    uids: number[],
    limit: number,
    beforeUid: number | null,
  ): Promise<MessageListPage> {
    const sorted = uids
      .filter((uid) => beforeUid === null || uid < beforeUid)
      .sort((a, b) => b - a);
    const page = sorted.slice(0, limit);
    const messages: MessageSummary[] = [];
    if (page.length > 0) {
      for await (const message of client.fetch(
        page.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
          bodyStructure: true,
          internalDate: true,
        },
        { uid: true },
      )) {
        messages.push(summarize(folder, uidValidity, message));
      }
    }
    messages.sort((a, b) => b.ref.uid - a.ref.uid);
    const last = page[page.length - 1];
    return {
      folder,
      uidValidity,
      messages,
      nextBeforeUid: sorted.length > page.length && last !== undefined ? last : null,
    };
  }

  async listMessages(
    account: MailAccountContext,
    options: { folder: string; limit: number; beforeUid: number | null; unreadOnly: boolean },
  ): Promise<MessageListPage> {
    return this.withImap(account, async (client) => {
      const folder = await this.requireFolder(client, options.folder);
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (mailbox === false)
          throw new MailError('unavailable', 'The folder could not be opened.');
        const uidValidity = mailbox.uidValidity.toString();
        const uids =
          (await client.search(options.unreadOnly ? { seen: false } : { all: true }, {
            uid: true,
          })) || [];
        return await this.pageFromUids(
          client,
          folder.path,
          uidValidity,
          uids,
          options.limit,
          options.beforeUid,
        );
      } finally {
        lock.release();
      }
    });
  }

  async search(
    account: MailAccountContext,
    options: { folder: string; criteria: SearchCriteria; limit: number; beforeUid: number | null },
  ): Promise<MessageListPage> {
    return this.withImap(account, async (client) => {
      const folder = await this.requireFolder(client, options.folder);
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (mailbox === false)
          throw new MailError('unavailable', 'The folder could not be opened.');
        const c = options.criteria;
        const query = {
          ...(c.text !== undefined ? { text: c.text } : {}),
          ...(c.from !== undefined ? { from: c.from } : {}),
          ...(c.to !== undefined ? { to: c.to } : {}),
          ...(c.subject !== undefined ? { subject: c.subject } : {}),
          ...(c.since !== undefined ? { since: new Date(c.since) } : {}),
          ...(c.before !== undefined ? { before: new Date(c.before) } : {}),
          ...(c.unreadOnly === true ? { seen: false } : {}),
        };
        const uids =
          (await client.search(Object.keys(query).length > 0 ? query : { all: true }, {
            uid: true,
          })) || [];
        return await this.pageFromUids(
          client,
          folder.path,
          mailbox.uidValidity.toString(),
          uids,
          options.limit,
          options.beforeUid,
        );
      } finally {
        lock.release();
      }
    });
  }

  /** Opens `ref.folder` read-only, checks UIDVALIDITY, returns the raw source (size-capped). */
  private async fetchSource(
    client: ImapFlow,
    ref: MessageRef,
    maxMessageBytes: number,
  ): Promise<{ summary: MessageSummary; source: Buffer }> {
    const folder = await this.requireFolder(client, ref.folder);
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (mailbox === false) throw new MailError('unavailable', 'The folder could not be opened.');
      if (mailbox.uidValidity.toString() !== ref.uidValidity) {
        throw new MailError(
          'stale_reference',
          'This message reference is out of date; list the folder again.',
        );
      }
      const meta = await client.fetchOne(
        String(ref.uid),
        {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
          bodyStructure: true,
          internalDate: true,
        },
        { uid: true },
      );
      if (meta === false || meta === undefined)
        throw new MailError('not_found', 'That message no longer exists.');
      if ((meta.size ?? 0) > maxMessageBytes) {
        throw new MailError(
          'too_large',
          `That message is larger than the ${Math.round(maxMessageBytes / 1048576)} MB this service will read.`,
        );
      }
      const full = await client.fetchOne(
        String(ref.uid),
        { uid: true, source: true },
        { uid: true },
      );
      if (full === false || full === undefined || full.source === undefined) {
        throw new MailError('not_found', 'That message no longer exists.');
      }
      return { summary: summarize(folder.path, ref.uidValidity, meta), source: full.source };
    } finally {
      lock.release();
    }
  }

  private static attachmentsOf(email: Email): Array<{ meta: AttachmentMeta; content: Buffer }> {
    return email.attachments.slice(0, 100).map((attachment, index) => {
      const content =
        typeof attachment.content === 'string'
          ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
          : Buffer.from(
              attachment.content instanceof ArrayBuffer
                ? new Uint8Array(attachment.content)
                : attachment.content,
            );
      return {
        meta: {
          attachmentId: `a${index}`,
          filename: cleanLine(attachment.filename, 255),
          contentType: cleanLine(attachment.mimeType, 127) ?? 'application/octet-stream',
          size: content.length,
        },
        content,
      };
    });
  }

  async getMessage(
    account: MailAccountContext,
    ref: MessageRef,
    options: { maxBodyChars: number; maxMessageBytes: number },
  ): Promise<FullMessage> {
    return this.withImap(account, async (client) => {
      const { summary, source } = await this.fetchSource(client, ref, options.maxMessageBytes);
      const email = await PostalMime.parse(source, { maxNestingDepth: 50, maxPartCount: 500 });
      const hadHtml = typeof email.html === 'string' && email.html.length > 0;
      const rawText =
        typeof email.text === 'string' && email.text.trim().length > 0
          ? stripControlCharacters(email.text)
          : hadHtml
            ? htmlToText(email.html ?? '')
            : '';
      const body = truncate(rawText, options.maxBodyChars);
      return {
        ...summary,
        subject: cleanLine(email.subject ?? null) ?? summary.subject,
        cc: flattenParsed(email.cc),
        replyTo: flattenParsed(email.replyTo),
        messageId: cleanLine(email.messageId ?? null, 998),
        inReplyTo: cleanLine(email.inReplyTo ?? null, 998),
        references: cleanLine(email.references ?? null, 4000),
        bodyText: body.text,
        bodyTruncated: body.truncated,
        hadHtml,
        attachments: ImapSmtpMailBackend.attachmentsOf(email).map((a) => a.meta),
      };
    });
  }

  async getAttachment(
    account: MailAccountContext,
    ref: MessageRef,
    attachmentId: string,
    maxBytes: number,
  ): Promise<AttachmentContent> {
    if (!/^a\d{1,3}$/.test(attachmentId))
      throw new MailError('invalid', 'That attachment id is not valid.');
    return this.withImap(account, async (client) => {
      const { source } = await this.fetchSource(
        client,
        ref,
        Math.max(maxBytes * 2, 30 * 1024 * 1024),
      );
      const email = await PostalMime.parse(source, { maxNestingDepth: 50, maxPartCount: 500 });
      const found = ImapSmtpMailBackend.attachmentsOf(email).find(
        (a) => a.meta.attachmentId === attachmentId,
      );
      if (found === undefined)
        throw new MailError('not_found', 'That attachment does not exist on this message.');
      if (found.content.length > maxBytes) {
        throw new MailError(
          'too_large',
          `That attachment exceeds the ${Math.round(maxBytes / 1024)} KB limit.`,
        );
      }
      return { meta: found.meta, data: found.content };
    });
  }

  async moveToTrash(
    account: MailAccountContext,
    refs: readonly MessageRef[],
  ): Promise<TrashMove[]> {
    return this.withImap(account, async (client) => {
      const trash = await this.findSpecial(client, '\\Trash', 'Trash');
      if (trash === null)
        throw new MailError(
          'invalid',
          'This mailbox has no Trash folder, so messages cannot be safely deleted.',
        );
      const moves: TrashMove[] = [];
      const byFolder = new Map<string, MessageRef[]>();
      for (const ref of refs) byFolder.set(ref.folder, [...(byFolder.get(ref.folder) ?? []), ref]);
      for (const [folderName, folderRefs] of byFolder) {
        const folder = await this.requireFolder(client, folderName);
        if (folder.path === trash.path) {
          throw new MailError(
            'invalid',
            'These messages are already in Trash; permanent deletion is not supported.',
          );
        }
        const lock = await client.getMailboxLock(folder.path);
        try {
          const mailbox = client.mailbox;
          if (mailbox === false)
            throw new MailError('unavailable', 'The folder could not be opened.');
          if (folderRefs.some((ref) => ref.uidValidity !== mailbox.uidValidity.toString())) {
            throw new MailError(
              'stale_reference',
              'A message reference is out of date; list the folder again.',
            );
          }
          const uids = folderRefs.map((ref) => ref.uid);
          const messageIds = new Map<number, string | null>();
          for await (const message of client.fetch(
            uids.join(','),
            { uid: true, envelope: true },
            { uid: true },
          )) {
            messageIds.set(message.uid, cleanLine(message.envelope?.messageId ?? null, 998));
          }
          const missing = uids.filter((uid) => !messageIds.has(uid));
          if (missing.length > 0)
            throw new MailError(
              'not_found',
              'One or more messages no longer exist; nothing was moved.',
            );
          const result = await client.messageMove(uids.join(','), trash.path, { uid: true });
          if (result === false)
            throw new MailError('unavailable', 'The mail server refused to move the messages.');
          const trashValidity = result.uidValidity?.toString() ?? null;
          for (const ref of folderRefs) {
            const newUid = result.uidMap?.get(ref.uid);
            moves.push({
              original: ref,
              trash:
                newUid !== undefined && trashValidity !== null
                  ? { folder: trash.path, uidValidity: trashValidity, uid: newUid }
                  : { folder: trash.path, uidValidity: '0', uid: 0 },
              messageId: messageIds.get(ref.uid) ?? null,
            });
          }
        } finally {
          lock.release();
        }
      }
      return moves;
    });
  }

  async restoreFromTrash(
    account: MailAccountContext,
    from: MessageRef,
    toFolder: string,
    expectedMessageId: string | null,
  ): Promise<MessageRef> {
    return this.withImap(account, async (client) => {
      const target = await this.requireFolder(client, toFolder);
      const trash = await this.requireFolder(client, from.folder);
      const lock = await client.getMailboxLock(trash.path);
      try {
        const mailbox = client.mailbox;
        if (mailbox === false)
          throw new MailError('unavailable', 'The folder could not be opened.');
        if (mailbox.uidValidity.toString() !== from.uidValidity) {
          throw new MailError(
            'stale_reference',
            'Trash has changed since the message was deleted; it can no longer be restored reliably.',
          );
        }
        const message = await client.fetchOne(
          String(from.uid),
          { uid: true, envelope: true },
          { uid: true },
        );
        if (message === false || message === undefined) {
          throw new MailError(
            'not_found',
            'The message is no longer in Trash (it may have been emptied).',
          );
        }
        const actualId = cleanLine(message.envelope?.messageId ?? null, 998);
        if (expectedMessageId !== null && actualId !== expectedMessageId) {
          throw new MailError(
            'stale_reference',
            'The message in Trash does not match the one that was deleted.',
          );
        }
        const result = await client.messageMove(String(from.uid), target.path, { uid: true });
        if (result === false)
          throw new MailError('unavailable', 'The mail server refused to move the message.');
        const newUid = result.uidMap?.get(from.uid);
        return {
          folder: target.path,
          uidValidity: result.uidValidity?.toString() ?? '0',
          uid: newUid ?? 0,
        };
      } finally {
        lock.release();
      }
    });
  }

  private smtpTransport(account: MailAccountContext) {
    const transport = account.transport;
    return nodemailer.createTransport({
      host: transport.smtpHost,
      port: transport.smtpPort,
      secure: transport.smtpSecurity === 'tls',
      requireTLS: transport.smtpSecurity === 'starttls',
      ignoreTLS: false,
      auth: { user: account.address, pass: account.password },
      tls: this.tlsOptions(account, transport.smtpHost),
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      // Never resolve attachment paths or URLs from message data.
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }

  static async compose(message: OutgoingMessage): Promise<Buffer> {
    const composer = new MailComposer({
      from:
        message.from.name !== null
          ? { name: message.from.name, address: message.from.address }
          : message.from.address,
      to: [...message.to],
      cc: [...message.cc],
      // Bcc never appears in the composed headers; it is only in the SMTP envelope.
      subject: message.subject,
      ...(message.text !== null ? { text: message.text } : {}),
      ...(message.html !== null ? { html: message.html } : {}),
      messageId: message.messageId,
      date: new Date(),
      ...(message.inReplyTo !== null ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.references !== null ? { references: message.references } : {}),
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachment.content,
      })),
      disableFileAccess: true,
      disableUrlAccess: true,
      headers: { 'X-Mailer': 'docker-webmail-gui MCP' },
    });
    return composer.compile().build();
  }

  async send(
    account: MailAccountContext,
    message: OutgoingMessage,
    options: { saveToSent: boolean },
  ): Promise<SendResult> {
    const raw = await ImapSmtpMailBackend.compose(message);
    const transporter = this.smtpTransport(account);
    let info;
    try {
      info = await transporter.sendMail({
        envelope: { from: account.address, to: [...message.to, ...message.cc, ...message.bcc] },
        raw,
      });
    } catch (err) {
      const e = err as { code?: string; command?: string; responseCode?: number };
      if (e.code === 'EAUTH' || e.responseCode === 535) {
        throw new MailError(
          'auth_failed',
          'The mail server rejected the mailbox credential for SMTP.',
        );
      }
      if (typeof e.responseCode === 'number') {
        // The server answered with a 4xx/5xx: the message was not accepted.
        throw new MailError(
          'send_rejected',
          `The mail server rejected the message (SMTP ${e.responseCode}). It was not sent.`,
        );
      }
      const preData = [
        'CONN',
        'EHLO',
        'HELO',
        'STARTTLS',
        'AUTH PLAIN',
        'AUTH LOGIN',
        'AUTH',
        'MAIL FROM',
        'RCPT TO',
        'API',
      ];
      if (e.command !== undefined && preData.includes(e.command)) {
        throw new MailError(
          'unavailable',
          'The SMTP submission server could not be reached. The message was not sent.',
        );
      }
      // The connection failed during or after DATA: delivery state unknown.
      throw new MailError(
        'send_uncertain',
        'The connection failed while the message was being submitted; it may or may not have been sent. It will not be retried automatically.',
      );
    } finally {
      transporter.close();
    }
    let savedToSent = false;
    let sentFolderError: string | null = null;
    if (options.saveToSent) {
      try {
        await this.withImap(account, async (client) => {
          const sent = await this.findSpecial(client, '\\Sent', 'Sent');
          if (sent === null) throw new MailError('not_found', 'No Sent folder exists.');
          await client.append(sent.path, raw, ['\\Seen']);
        });
        savedToSent = true;
      } catch (err) {
        sentFolderError = err instanceof MailError ? err.message : 'Could not file a copy in Sent.';
      }
    }
    return {
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: cleanLine(String(info.response ?? ''), 200) ?? '',
      savedToSent,
      sentFolderError,
    };
  }
}

export function generateMessageId(fromAddress: string): string {
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1) || 'localhost';
  return `<${randomBytes(16).toString('hex')}.mcp@${domain}>`;
}
