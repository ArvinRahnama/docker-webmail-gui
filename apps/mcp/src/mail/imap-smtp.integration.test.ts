/**
 * Integration suite against a **real docker-mailserver** (Dovecot IMAP +
 * Postfix submission over TLS). Not part of `npm test`: run with
 * `npm run test:integration --workspace apps/mcp` and these variables
 * (the mcp-integration job in .github/workflows/ci.yml provisions them):
 *
 *   MCP_IT_IMAP_HOST / MCP_IT_IMAP_PORT     e.g. 127.0.0.1 / 19993 (implicit TLS)
 *   MCP_IT_SMTP_HOST / MCP_IT_SMTP_PORT     e.g. 127.0.0.1 / 19465 (implicit TLS)
 *   MCP_IT_TLS_SERVERNAME                   certificate name, e.g. mail.example.test
 *   MCP_IT_CA_FILE                          PEM CA that signed the test certificate
 *   MCP_IT_SALES_PASSWORD / MCP_IT_SUPPORT_PASSWORD
 *                                           for sales@example.test / support@example.test
 *   MCP_IT_DMS_CONTAINER (optional)         container name, enables the out-of-band
 *                                           password-change scenario via `docker exec`
 *
 * Everything below goes through the real public HTTP surface: OAuth with the
 * setup credential, then MCP tool calls that hit the real IMAP/SMTP servers.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpLogger } from '../platform/logger.js';
import { ImapSmtpMailBackend } from './imap-smtp-backend.js';
import {
  callTool,
  connectClient,
  createConnection,
  createHarness,
  mcpCall,
  type CreatedConnection,
  type Harness,
  type Tokens,
} from '../mcp-test-harness.js';
import { decodeMessageRef, encodeMessageRef } from './message-ref.js';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new Error(`${name} must be set for the integration suite`);
  return value;
};

const SALES = 'sales@example.test';
const SUPPORT = 'support@example.test';

let h: Harness;
let backend: ImapSmtpMailBackend;
let sales: { connection: CreatedConnection; tokens: Tokens };
let support: { connection: CreatedConnection; tokens: Tokens };
const marker = `it-${randomBytes(6).toString('hex')}`;

function transport() {
  return {
    imapHost: env('MCP_IT_IMAP_HOST'),
    imapPort: Number(env('MCP_IT_IMAP_PORT')),
    imapSecurity: 'tls' as const,
    smtpHost: env('MCP_IT_SMTP_HOST'),
    smtpPort: Number(env('MCP_IT_SMTP_PORT')),
    smtpSecurity: 'tls' as const,
    tlsServername: env('MCP_IT_TLS_SERVERNAME'),
    tlsVerify: true,
  };
}

async function waitForSubject(
  who: { connection: CreatedConnection; tokens: Tokens },
  folder: string,
  subject: string,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await callTool(h, who.connection.id, who.tokens.accessToken, 'mail_search', {
      folder,
      subject,
      limit: 5,
    });
    const messages = (result.structuredContent?.['messages'] ?? []) as Array<{
      id: string;
      subject: string;
    }>;
    const found = messages.find((m) => m.subject === subject);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`message "${subject}" did not arrive in ${folder}`);
}

beforeAll(async () => {
  backend = new ImapSmtpMailBackend({
    tlsCa: readFileSync(env('MCP_IT_CA_FILE'), 'utf8'),
    logger: createMcpLogger({ level: 'silent' }),
  });
  h = await createHarness({ backend, mailSettings: transport() });
  const salesConnection = await createConnection(h, SALES, {
    password: env('MCP_IT_SALES_PASSWORD'),
  });
  const supportConnection = await createConnection(h, SUPPORT, {
    password: env('MCP_IT_SUPPORT_PASSWORD'),
  });
  sales = { connection: salesConnection, tokens: await connectClient(h, salesConnection) };
  support = { connection: supportConnection, tokens: await connectClient(h, supportConnection) };
});

afterAll(async () => {
  await h?.close();
});

describe('real IMAP/SMTP (docker-mailserver)', () => {
  it('verifies credentials over TLS and detects a wrong password as an authentication failure', async () => {
    const good = await backend.verify({
      address: SALES,
      password: env('MCP_IT_SALES_PASSWORD'),
      transport: transport(),
    });
    expect(good.imap.ok).toBe(true);
    expect(good.smtp.ok).toBe(true);
    expect(good.imap.folderCount).toBeGreaterThanOrEqual(4);
    const bad = await backend.verify({
      address: SALES,
      password: 'definitely-wrong',
      transport: transport(),
    });
    expect(bad.imap.ok).toBe(false);
    expect(bad.imap.authFailed).toBe(true);
    expect(bad.smtp.authFailed).toBe(true);
  });

  it('refuses to provision a wrong mailbox password (nothing stored)', async () => {
    await expect(createConnection(h, SALES, { password: 'definitely-wrong' })).rejects.toThrow(
      /rejected this mailbox password/,
    );
  });

  it('lists real folders including the special-use Trash and Sent', async () => {
    const result = await callTool(
      h,
      sales.connection.id,
      sales.tokens.accessToken,
      'mail_list_folders',
    );
    const folders = result.structuredContent?.['folders'] as Array<{
      path: string;
      specialUse: string | null;
    }>;
    expect(folders.find((f) => f.specialUse === '\\Trash')).toBeDefined();
    expect(folders.find((f) => f.specialUse === '\\Sent')).toBeDefined();
  });

  it('sales sends to support over authenticated SMTP with an attachment; a copy is filed in Sent', async () => {
    const result = await callTool(h, sales.connection.id, sales.tokens.accessToken, 'mail_send', {
      to: [SUPPORT],
      subject: `Hello ${marker}`,
      text: `Body ${marker}\nSecond line.`,
      attachments: [
        {
          filename: 'notes.txt',
          contentType: 'text/plain',
          contentBase64: Buffer.from(`attachment ${marker}`).toString('base64'),
        },
      ],
      idempotencyKey: `send-${marker}`,
      confirm: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.['status']).toBe('sent');
    expect(result.structuredContent?.['accepted']).toEqual([SUPPORT]);
    expect(result.structuredContent?.['savedToSent']).toBe(true);
    await waitForSubject(sales, 'Sent', `Hello ${marker}`);
    const retry = await callTool(h, sales.connection.id, sales.tokens.accessToken, 'mail_send', {
      to: [SUPPORT],
      subject: `Hello ${marker}`,
      text: 'x',
      idempotencyKey: `send-${marker}`,
      confirm: true,
    });
    expect(retry.structuredContent?.['status']).toBe('already_sent');
  });

  it('support receives, reads (without marking seen) and downloads the attachment', async () => {
    const found = await waitForSubject(support, 'INBOX', `Hello ${marker}`);
    const read = await callTool(h, support.connection.id, support.tokens.accessToken, 'mail_read', {
      id: found.id,
    });
    expect(read.structuredContent?.['body']).toContain(`Body ${marker}`);
    expect(read.structuredContent?.['from']).toContain(SALES);
    expect(read.structuredContent?.['seen']).toBe(false);
    const attachments = read.structuredContent?.['attachments'] as Array<{
      attachmentId: string;
      filename: string;
    }>;
    expect(attachments.map((a) => a.filename)).toContain('notes.txt');
    const attachment = await callTool(
      h,
      support.connection.id,
      support.tokens.accessToken,
      'mail_get_attachment',
      {
        id: found.id,
        attachmentId: attachments.find((a) => a.filename === 'notes.txt')!.attachmentId,
      },
    );
    expect(JSON.stringify(attachment)).toContain(`attachment ${marker}`);
    // BODY.PEEK: still unseen after reading.
    const again = await callTool(
      h,
      support.connection.id,
      support.tokens.accessToken,
      'mail_read',
      { id: found.id },
    );
    expect(again.structuredContent?.['seen']).toBe(false);
  });

  it('isolation: sales cannot see, read or forge access to support’s message', async () => {
    const supportMessage = await waitForSubject(support, 'INBOX', `Hello ${marker}`);
    // Searching its own INBOX, sales finds nothing (the message is in support's mailbox only).
    const search = await callTool(h, sales.connection.id, sales.tokens.accessToken, 'mail_search', {
      subject: `Hello ${marker}`,
    });
    expect((search.structuredContent?.['messages'] as unknown[]).length).toBe(0);
    // Support's message id, replayed through sales' connection, is resolved inside sales' mailbox.
    const forged = await callTool(h, sales.connection.id, sales.tokens.accessToken, 'mail_read', {
      id: supportMessage.id,
    });
    expect(JSON.stringify(forged)).not.toContain(`Body ${marker}`);
    // Sales' token at support's endpoint is refused outright.
    expect(
      (await mcpCall(h, support.connection.id, sales.tokens.accessToken, 'tools/list')).status,
    ).toBe(401);
    // Sales cannot send as support.
    const spoof = await callTool(h, sales.connection.id, sales.tokens.accessToken, 'mail_send', {
      to: [SALES],
      from: SUPPORT,
      subject: 'spoof',
      text: 'x',
      confirm: true,
    });
    expect(spoof.isError).toBe(true);
  });

  it('delete moves to the real Trash (UIDPLUS) and restore moves it back', async () => {
    const found = await waitForSubject(support, 'INBOX', `Hello ${marker}`);
    const deleted = await callTool(
      h,
      support.connection.id,
      support.tokens.accessToken,
      'mail_delete',
      { ids: [found.id], confirm: true },
    );
    const moved = (
      deleted.structuredContent?.['moved'] as Array<{
        restoreId: string | null;
        trashId: string | null;
      }>
    )[0]!;
    expect(moved.restoreId).not.toBeNull();
    expect(decodeMessageRef(moved.trashId!)?.folder).toBe('Trash');
    const inbox = await callTool(
      h,
      support.connection.id,
      support.tokens.accessToken,
      'mail_search',
      { subject: `Hello ${marker}` },
    );
    expect((inbox.structuredContent?.['messages'] as unknown[]).length).toBe(0);
    await waitForSubject(support, 'Trash', `Hello ${marker}`);

    const restored = await callTool(
      h,
      support.connection.id,
      support.tokens.accessToken,
      'mail_restore',
      { restoreIds: [moved.restoreId] },
    );
    const outcome = (
      restored.structuredContent?.['results'] as Array<{ restored: boolean; id: string | null }>
    )[0]!;
    expect(outcome.restored).toBe(true);
    expect(decodeMessageRef(outcome.id!)?.folder).toBe('INBOX');
    await waitForSubject(support, 'INBOX', `Hello ${marker}`);
  });

  it('a stale UIDVALIDITY reference is refused rather than guessed', async () => {
    const found = await waitForSubject(support, 'INBOX', `Hello ${marker}`);
    const ref = decodeMessageRef(found.id)!;
    const stale = encodeMessageRef({ ...ref, uidValidity: String(Number(ref.uidValidity) + 1) });
    const result = await callTool(
      h,
      support.connection.id,
      support.tokens.accessToken,
      'mail_read',
      { id: stale },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/out of date/);
  });

  it.runIf(
    process.env['MCP_IT_DMS_CONTAINER'] !== undefined && process.env['MCP_IT_DMS_CONTAINER'] !== '',
  )(
    'an out-of-band password change (setup email update) suspends the connection on next use',
    async () => {
      const container = env('MCP_IT_DMS_CONTAINER');
      const newPassword = `Sales-rotated-${marker}`;
      execFileSync('docker', ['exec', container, 'setup', 'email', 'update', SALES, newPassword], {
        stdio: 'ignore',
      });
      try {
        let suspended = false;
        for (let attempt = 0; attempt < 20 && !suspended; attempt += 1) {
          const result = await callTool(
            h,
            sales.connection.id,
            sales.tokens.accessToken,
            'mail_list_folders',
          ).catch(() => null);
          if (result === null || result.isError === true) suspended = true;
          else await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        expect(suspended).toBe(true);
        expect(
          (await mcpCall(h, sales.connection.id, sales.tokens.accessToken, 'tools/list')).status,
        ).toBe(401);
        const detail = h.services.connections.get(sales.connection.id);
        expect(detail.status).toBe('suspended');
        expect(detail.credentialHealth).toBe('invalid');
      } finally {
        execFileSync(
          'docker',
          ['exec', container, 'setup', 'email', 'update', SALES, env('MCP_IT_SALES_PASSWORD')],
          { stdio: 'ignore' },
        );
      }
    },
  );
});
