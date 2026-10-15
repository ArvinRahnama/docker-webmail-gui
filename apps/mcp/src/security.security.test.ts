/**
 * Cross-cutting security properties of apps/mcp (docs/mcp-integration.md
 * §Security model). Named `*.security.test.ts` per SECURITY.md Part 5.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_CONTROL_AUTH_HEADER } from '@dwg/shared';
import {
  callTool,
  connectClient,
  control,
  createConnection,
  createHarness,
  refreshTokens,
  type Harness,
} from './mcp-test-harness.js';
import { encodeMessageRef } from './mail/message-ref.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('control API', () => {
  it('rejects every control route without the control secret, or with the wrong one', async () => {
    for (const [method, url] of [
      ['GET', '/control/v1/status'],
      ['GET', '/control/v1/connections'],
      ['POST', '/control/v1/connections'],
      ['PATCH', '/control/v1/settings'],
      ['POST', '/control/v1/mailboxes/events'],
    ] as const) {
      const none = await h.controlApp.inject({ method, url });
      expect(none.statusCode, `${method} ${url}`).toBe(401);
      const wrong = await h.controlApp.inject({
        method,
        url,
        headers: { [MCP_CONTROL_AUTH_HEADER]: 'x'.repeat(48) },
      });
      expect(wrong.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('the public listener exposes no control route', async () => {
    const response = await h.publicApp.inject({
      method: 'GET',
      url: '/control/v1/status',
      headers: { [MCP_CONTROL_AUTH_HEADER]: 'c'.repeat(48) },
    });
    expect(response.statusCode).toBe(404);
  });

  it('never returns a setup password after the one-time response, and never the mailbox password', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    for (const url of [
      `/connections/${connection.id}`,
      '/connections',
      `/connections/${connection.id}/audit`,
      '/status',
      '/audit',
      '/mailboxes/sales@example.test',
    ]) {
      const body = (await control(h, 'GET', url)).body;
      expect(body).not.toContain(connection.setupPassword);
      expect(body).not.toContain('sales-imap-password');
    }
  });

  it('refuses to create a connection while MCP is disabled', async () => {
    h.services.settings.update({ enabled: false }, h.clock.now().toISOString());
    await expect(createConnection(h, 'sales@example.test')).rejects.toThrow(/409/);
  });

  it('refuses to store a mailbox password the mail server rejects', async () => {
    await expect(createConnection(h, 'sales@example.test', { password: 'wrong' })).rejects.toThrow(
      /rejected this mailbox password/,
    );
    expect(h.services.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_credentials')?.n).toBe(
      0,
    );
  });

  it('grant revocation is scoped to the connection named in the path (no IDOR)', async () => {
    const a = await createConnection(h, 'sales@example.test');
    const b = await createConnection(h, 'support@example.test');
    await connectClient(h, a);
    await connectClient(h, b);
    const grantB = h.services.oauth.listGrants(b.id)[0]!;
    const response = await control(h, 'POST', `/connections/${a.id}/grants/${grantB.id}/revoke`, {
      actor: 'p@example.test',
    });
    expect(response.statusCode).toBe(404);
    expect(h.services.oauth.findGrant(grantB.id)?.revokedAt).toBeNull();
  });
});

describe('secrets never reach logs', () => {
  it('a full create → authorize → token → refresh → read → send cycle logs no secret or message content', async () => {
    h.mail.deliver('sales@example.test', 'INBOX', {
      subject: 'Confidential subject line',
      from: 'a@example.test',
      body: 'BODY-SENTINEL-7781',
    });
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const refreshed = (await refreshTokens(h, tokens.clientId, tokens.refreshToken)).json() as {
      access_token: string;
      refresh_token: string;
    };
    const inbox = h.mail.state('sales@example.test').folders.get('INBOX')!;
    await callTool(h, connection.id, refreshed.access_token, 'mail_read', {
      id: encodeMessageRef({ folder: 'INBOX', uidValidity: inbox.uidValidity, uid: 3 }),
    });
    await callTool(h, connection.id, refreshed.access_token, 'mail_send', {
      to: ['x@example.org'],
      subject: 'SEND-SUBJECT-SENTINEL',
      text: 'SEND-BODY-SENTINEL',
      confirm: true,
    });

    const raw = h.logLines.join('');
    expect(raw.length).toBeGreaterThan(0);
    for (const secret of [
      connection.setupPassword,
      'sales-imap-password',
      tokens.accessToken,
      tokens.refreshToken,
      refreshed.access_token,
      refreshed.refresh_token,
      'BODY-SENTINEL-7781',
      'Confidential subject line',
      'SEND-SUBJECT-SENTINEL',
      'SEND-BODY-SENTINEL',
      h.config.controlSecret,
    ]) {
      expect(raw.includes(secret), `log contains ${secret.slice(0, 12)}…`).toBe(false);
    }
    // And the audit trail holds no message content either.
    const audit = JSON.stringify(h.services.audit.list({ limit: 500 }));
    for (const secret of [
      'BODY-SENTINEL-7781',
      'Confidential subject line',
      'SEND-BODY-SENTINEL',
      connection.setupPassword,
    ]) {
      expect(audit.includes(secret)).toBe(false);
    }
  });
});

describe('privilege boundaries', () => {
  const srcRoot = fileURLToPath(new URL('.', import.meta.url));
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory()
        ? sourceFiles(path)
        : path.endsWith('.ts') && !path.endsWith('.test.ts')
          ? [path]
          : [];
    });
  }

  it('apps/mcp has no Docker client, no Docker socket path and no broker vocabulary', () => {
    const pkg = JSON.parse(readFileSync(join(srcRoot, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const forbidden of ['dockerode', 'docker-modem'])
      expect(Object.keys(pkg.dependencies)).not.toContain(forbidden);
    for (const file of sourceFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes('docker.sock'), file).toBe(false);
      expect(/from ['"]dockerode['"]/.test(text), file).toBe(false);
      expect(text.includes('BROKER_SHARED_SECRET'), file).toBe(false);
    }
  });
});
