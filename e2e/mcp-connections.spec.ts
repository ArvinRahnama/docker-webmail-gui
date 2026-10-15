/**
 * MCP Connections (docs/mcp-integration.md), end to end across all three
 * processes: the postmaster's browser on the panel, the panel server, and
 * the separate MCP service it controls (playwright.config.ts starts it with
 * the fake mail backend — the real IMAP/SMTP path is covered by
 * .github/workflows/mcp-integration.yml).
 *
 * The one test walks the whole lifecycle in order, because each step needs
 * the state the previous one produced (one MCP service backs the run):
 *
 *   enable the service → generate a connection → the one-time credential
 *   dialog (shown once, not dismissable before acknowledgement, gone
 *   afterwards) → the mailbox owner's side: the hosted OAuth login with the
 *   setup credential in a real browser, consent, redirect with a code →
 *   token exchange → MCP tool calls (list, read, send — refused without
 *   confirm — delete to Trash, restore) → the setup credential is single-use →
 *   disable (tools denied) → enable → reissue → revoke (tools and refresh
 *   denied immediately).
 *
 * A second test checks the pages at a phone-sized viewport.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { AUTH_STATE_PATH, E2E_MAIL_DOMAIN, MCP_PUBLIC_ORIGIN } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });
test.describe.configure({ mode: 'serial' });

const MAILBOX = `e2e-mcp@${E2E_MAIL_DOMAIN}`;
// A real loopback listener, as a native MCP client would run (RFC 8252):
// Playwright cannot route the redirect hop of a form POST, so the browser
// must actually land somewhere.
const CALLBACK_PORT = 3999;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

async function createMailbox(page: Page, email: string): Promise<void> {
  await page.goto('/mail/mailboxes');
  await page.getByRole('button', { name: 'Add mailbox' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address', { exact: true }).fill(email);
  await dialog.getByLabel('Password', { exact: true }).fill('e2e-mcp-mailbox-password');
  await dialog.getByLabel('Confirm password', { exact: true }).fill('e2e-mcp-mailbox-password');
  await dialog.getByRole('button', { name: 'Create mailbox' }).click();
  await expect(dialog).toBeHidden();
}

async function ensureServiceEnabled(page: Page): Promise<void> {
  await page.goto('/mail/mcp');
  await expect(page.getByRole('heading', { name: 'MCP Connections' })).toBeVisible();
  const generate = page.getByRole('button', { name: 'Generate connection' }).first();
  await expect(generate).toBeVisible();
  if (await generate.isEnabled()) return;

  await page.getByRole('button', { name: 'Service settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'MCP service settings' });
  await dialog.getByLabel('Public HTTPS endpoint').fill(MCP_PUBLIC_ORIGIN);
  await dialog.getByRole('switch', { name: 'Enable MCP' }).click();
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(generate).toBeEnabled();
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

async function mcpCall(
  api: APIRequestContext,
  mcpUrl: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{
  status: number;
  body: {
    result?: {
      content?: { text: string }[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    error?: unknown;
  };
}> {
  const response = await api.post(mcpUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
    },
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  const text = await response.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  let body = {};
  try {
    body = JSON.parse(dataLine !== undefined ? dataLine.slice('data: '.length) : text);
  } catch {
    /* non-JSON error bodies leave body empty; the status is what callers check */
  }
  return { status: response.status(), body };
}

let callbackServer: Server;
test.beforeAll(async () => {
  callbackServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('callback reached');
  });
  await new Promise<void>((resolve) => callbackServer.listen(CALLBACK_PORT, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
});

test.describe('MCP connections', () => {
  test('postmaster issues a connection; the mailbox owner authorizes it; revocation is immediate', async ({
    page,
    browser,
    request,
  }) => {
    await createMailbox(page, MAILBOX);
    await ensureServiceEnabled(page);

    // --- generate a connection -------------------------------------------
    await page.getByRole('button', { name: 'Generate connection' }).first().click();
    const create = page.getByRole('dialog', { name: 'Generate MCP connection' });
    await create.getByLabel('Search mailboxes').fill('e2e-mcp');
    await create.getByLabel('Mailbox', { exact: true }).selectOption(MAILBOX);
    await expect(create.getByLabel('Read and search messages')).toBeChecked();
    await expect(create.getByLabel('Send messages as this mailbox')).toBeChecked();
    await expect(create.getByLabel('Move messages to Trash (and restore them)')).toBeChecked();
    await create.getByLabel('Mailbox password').fill('e2e-mcp-mailbox-password');
    await create.getByRole('button', { name: 'Generate connection' }).click();

    // --- the one-time credential dialog -----------------------------------
    const once = page.getByRole('dialog', { name: 'Connection generated' });
    await expect(once.getByText(/cannot be viewed again/)).toBeVisible();
    const codes = once.locator('code');
    const mcpUrl = (await codes.nth(0).textContent())!.trim();
    const username = (await codes.nth(1).textContent())!.trim();
    const setupPassword = (await codes.nth(2).textContent())!.trim();
    expect(mcpUrl).toMatch(new RegExp(`^${MCP_PUBLIC_ORIGIN}/mcp/c[0-9a-z]{26}$`));
    expect(username).toMatch(/^mcp-/);
    expect(setupPassword).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){5}$/);
    expect(setupPassword).not.toContain('e2e-mcp-mailbox-password');

    const done = once.getByRole('button', { name: 'Done' });
    await expect(done).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(once).toBeVisible(); // not dismissable before acknowledging
    await once.getByRole('checkbox').check();
    await done.click();
    await expect(once).toBeHidden();
    await expect(page.getByText(setupPassword)).toHaveCount(0);

    const connectionId = mcpUrl.split('/').pop()!;
    await page.goto(`/mail/mcp/${connectionId}`);
    await expect(page.getByText('Awaiting authorization', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(setupPassword)).toHaveCount(0);

    // --- the mailbox owner's side: hosted OAuth login in a real browser ----
    const registration = await request.post(`${MCP_PUBLIC_ORIGIN}/oauth/register`, {
      data: {
        client_name: 'E2E MCP client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    });
    expect(registration.status()).toBe(201);
    const clientId = ((await registration.json()) as { client_id: string }).client_id;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeUrl = `${MCP_PUBLIC_ORIGIN}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'e2e-state',
      resource: mcpUrl,
      scope: 'mail.read mail.send mail.delete offline_access',
    })}`;

    // A fresh browser context: the mailbox owner is not the postmaster and
    // shares none of the panel's cookies.
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    await ownerPage.goto(authorizeUrl);
    await expect(ownerPage.getByText(MAILBOX)).toHaveCount(0); // masked before login
    await ownerPage.getByLabel('MCP username').fill(username);
    await ownerPage.getByLabel('Setup password').fill(setupPassword.toLowerCase());
    await ownerPage.getByRole('button', { name: 'Continue' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Authorize' })).toBeVisible();
    await expect(ownerPage.getByText(MAILBOX).first()).toBeVisible();
    await Promise.all([
      ownerPage.waitForURL(`${REDIRECT_URI}**`),
      ownerPage.getByRole('button', { name: 'Authorize' }).click(),
    ]);
    const callback = new URL(ownerPage.url());
    expect(callback.searchParams.get('state')).toBe('e2e-state');
    expect(callback.searchParams.get('iss')).toBe(MCP_PUBLIC_ORIGIN);
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await request.post(`${MCP_PUBLIC_ORIGIN}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: mcpUrl,
      },
    });
    expect(tokenResponse.status()).toBe(200);
    const tokens = (await tokenResponse.json()) as Tokens;

    // --- MCP tool calls ----------------------------------------------------
    const initialize = await mcpCall(request, mcpUrl, tokens.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    });
    expect(initialize.status).toBe(200);
    const folders = await mcpCall(request, mcpUrl, tokens.access_token, 'tools/call', {
      name: 'mail_list_folders',
      arguments: {},
    });
    expect(folders.status).toBe(200);
    expect(folders.body.result?.isError).not.toBe(true);
    expect(folders.body.result?.content?.[0]?.text).toContain('INBOX');

    const call = (name: string, args: Record<string, unknown>) =>
      mcpCall(request, mcpUrl, tokens.access_token, 'tools/call', { name, arguments: args });

    // Read: list the inbox, then read one message.
    const listed = await call('mail_list_messages', { folder: 'INBOX' });
    expect(listed.body.result?.isError).not.toBe(true);
    const messages = listed.body.result?.structuredContent?.['messages'] as { id: string }[];
    expect(messages.length).toBeGreaterThan(0);
    const read = await call('mail_read', { id: messages[0]!.id });
    expect(read.body.result?.isError).not.toBe(true);
    expect(read.body.result?.structuredContent?.['id']).toBe(messages[0]!.id);

    // Send: refused without explicit confirmation, accepted with it.
    const unconfirmed = await call('mail_send', {
      to: [MAILBOX],
      subject: 'E2E hello',
      text: 'Sent by the MCP E2E test.',
    });
    expect(unconfirmed.body.error ?? unconfirmed.body.result?.isError).toBeTruthy();
    const sent = await call('mail_send', {
      to: [MAILBOX],
      subject: 'E2E hello',
      text: 'Sent by the MCP E2E test.',
      confirm: true,
      idempotencyKey: 'e2e-send-0001',
    });
    expect(sent.body.result?.isError).not.toBe(true);

    // Delete: moves to Trash (never purges) and hands back a restore id.
    const deleted = await call('mail_delete', { ids: [messages[0]!.id], confirm: true });
    expect(deleted.body.result?.isError).not.toBe(true);
    const moved = deleted.body.result?.structuredContent?.['moved'] as {
      restoreId: string | null;
    }[];
    expect(moved[0]?.restoreId).toBeTruthy();
    const restored = await call('mail_restore', { restoreIds: [moved[0]!.restoreId] });
    expect(restored.body.result?.isError).not.toBe(true);

    // The setup credential worked once; it never works again.
    await ownerPage.goto(authorizeUrl);
    await ownerPage.getByLabel('MCP username').fill(username);
    await ownerPage.getByLabel('Setup password').fill(setupPassword);
    await ownerPage.getByRole('button', { name: 'Continue' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Authorize' })).toHaveCount(0);
    await owner.close();

    // --- the postmaster sees it active ------------------------------------
    await page.reload();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

    // --- disable: tools are denied immediately; enable restores -----------
    await page.getByRole('button', { name: 'Disable' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disable' }).click();
    await expect(page.getByText('Disabled', { exact: true }).first()).toBeVisible();
    const whileDisabled = await mcpCall(request, mcpUrl, tokens.access_token, 'tools/call', {
      name: 'mail_list_folders',
      arguments: {},
    });
    expect(whileDisabled.status).toBe(403);
    await page.getByRole('button', { name: 'Enable' }).click();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

    // --- reissue: a new setup password, shown once ------------------------
    await page.getByRole('button', { name: /^Reissue/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reissue' }).click();
    const reissued = page.getByRole('dialog', { name: 'New setup credentials' });
    await expect(reissued).toBeVisible();
    const newSetupPassword = (await reissued.locator('code').nth(2).textContent())!.trim();
    expect(newSetupPassword).not.toBe(setupPassword);
    await reissued.getByRole('checkbox').check();
    await reissued.getByRole('button', { name: 'Done' }).click();
    await expect(reissued).toBeHidden();

    // --- revoke: type-to-confirm, then everything stops -------------------
    await page.getByRole('button', { name: 'Revoke' }).first().click();
    const confirm = page.getByRole('alertdialog');
    const revokeButton = confirm.getByRole('button', { name: 'Revoke' });
    await expect(revokeButton).toBeDisabled();
    await confirm.getByRole('textbox').fill(MAILBOX);
    await revokeButton.click();
    await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible();

    const afterRevoke = await mcpCall(request, mcpUrl, tokens.access_token, 'tools/call', {
      name: 'mail_list_folders',
      arguments: {},
    });
    expect([401, 403, 404]).toContain(afterRevoke.status);
    const refresh = await request.post(`${MCP_PUBLIC_ORIGIN}/oauth/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      },
    });
    expect(refresh.status()).toBe(400);
  });

  test('the MCP pages work at a phone-sized viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/mail/mcp');
    await expect(page.getByRole('heading', { name: 'MCP Connections' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate connection' }).first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // The first test left a (revoked) connection for MAILBOX behind.
    await page
      .getByRole('button', { name: `Manage connection for ${MAILBOX}` })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(MAILBOX).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete record' })).toBeVisible();
    const detailOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(detailOverflow).toBeLessThanOrEqual(0);
  });
});
