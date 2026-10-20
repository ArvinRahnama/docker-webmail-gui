/**
 * `/api/v1/mcp/*` in the admin tier: postmaster-only access, mailbox
 * existence + identity fingerprinting before anything reaches apps/mcp,
 * sender-identity verification, audit, no-store one-time credentials, and
 * the mailbox lifecycle hooks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER_NAME, type McpControlCreateConnectionRequest } from '@dwg/shared';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logger.js';
import { AdminsRepository } from '../auth/admins.repository.js';
import { hashPassword } from '../auth/password.js';
import { SESSION_COOKIE_NAME } from '../auth/auth.middleware.js';
import {
  FakeMcpControlClient,
  NotConfiguredMcpControlClient,
  type McpControlClient,
} from '../../drivers/mcp-control/index.js';
import { createDmsDriver } from '../../drivers/dms/index.js';
import { FakeBrokerClient } from '../../drivers/broker/index.js';
import { mailboxIdentityFingerprint } from './mcp.service.js';
import { loginAs, SAME_ORIGIN_HEADERS } from '../mail/mail-test-harness.js';

const EMAIL = 'postmaster-admin@example.com';
const PASSWORD = 'correct-horse-battery-staple';

interface Ctx {
  db: Database;
  app: FastifyInstance;
  control: FakeMcpControlClient;
  logLines: string[];
}

async function setUp(control?: McpControlClient): Promise<Ctx> {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  new AdminsRepository(db).create({
    email: EMAIL,
    passwordHash: await hashPassword(PASSWORD),
    role: 'administrator',
    forcePasswordChange: false,
  });
  const logLines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    stream: { write: (chunk: string) => void logLines.push(chunk) },
  });
  const fake = new FakeMcpControlClient();
  fake.settings = { ...fake.settings, enabled: true };
  const app = await buildApp({
    config: loadConfig({}),
    logger,
    db,
    mcpControlClient: control ?? fake,
  });
  return { db, app, control: fake, logLines };
}

let ctx: Ctx;
let auth: { token: string; csrfToken: string };
beforeEach(async () => {
  ctx = await setUp();
  auth = await loginAs(ctx.app, EMAIL, PASSWORD);
});
afterEach(async () => {
  await ctx.app.close();
  ctx.db.close();
});

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return ctx.app.inject({
    method,
    url,
    cookies: { [SESSION_COOKIE_NAME]: auth.token },
    headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: auth.csrfToken },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

describe('access control', () => {
  it('requires a session for every MCP route', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/mcp/status'],
      ['GET', '/api/v1/mcp/connections'],
      ['POST', '/api/v1/mcp/connections'],
      ['PATCH', '/api/v1/mcp/settings'],
    ] as const) {
      const response = await ctx.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('requires CSRF for mutations', async () => {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/mcp/settings',
      cookies: { [SESSION_COOKIE_NAME]: auth.token },
      headers: SAME_ORIGIN_HEADERS,
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(403);
    expect(ctx.control.calls.find((c) => c.method === 'patchSettings')).toBeUndefined();
  });
});

describe('mcp:manage permission', () => {
  it('is required server-side by every MCP route', async () => {
    const roles = await import('../auth/roles.js');
    const spy = vi
      .spyOn(roles, 'roleHasPermission')
      .mockImplementation((_role, permission) => permission !== 'mcp:manage');
    try {
      for (const [method, url] of [
        ['GET', '/api/v1/mcp/status'],
        ['GET', '/api/v1/mcp/connections'],
        ['POST', '/api/v1/mcp/connections'],
        ['GET', '/api/v1/mcp/settings'],
        ['POST', '/api/v1/mcp/discovery-check'],
      ] as const) {
        const response = await call(method, url, method === 'POST' ? {} : undefined);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
      expect(ctx.control.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('is granted to administrators (the postmasters)', async () => {
    const { roleHasPermission } = await import('../auth/roles.js');
    expect(roleHasPermission('administrator', 'mcp:manage')).toBe(true);
  });
});

describe('status', () => {
  it('reports the service and its counts', async () => {
    const response = await call('GET', '/api/v1/mcp/status');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deployed: true,
      service: { enabled: true },
    });
  });

  it('reports "not enabled" honestly when MCP_ENABLED is off', async () => {
    await ctx.app.close();
    ctx = await setUp(new NotConfiguredMcpControlClient());
    auth = await loginAs(ctx.app, EMAIL, PASSWORD);
    const status = await call('GET', '/api/v1/mcp/status');
    expect(status.json()).toMatchObject({ deployed: false, service: null });
    expect((status.json() as { reason: string }).reason).toContain('turned off');
    const list = await call('GET', '/api/v1/mcp/connections');
    expect(list.statusCode).toBe(409);
    expect(list.json()).toMatchObject({ error: { code: 'CAPABILITY_UNSUPPORTED' } });
  });
});

describe('connections', () => {
  it('refuses a mailbox that does not exist, before contacting apps/mcp', async () => {
    const response = await call('POST', '/api/v1/mcp/connections', {
      mailbox: 'nobody@example.com',
      label: 'x',
      permissions: ['mail.read'],
    });
    expect(response.statusCode).toBe(404);
    expect(ctx.control.calls.find((c) => c.method === 'createConnection')).toBeUndefined();
  });

  it('creates a connection with the mailbox identity fingerprint and returns the one-time credential once, no-store', async () => {
    const response = await call('POST', '/api/v1/mcp/connections', {
      mailbox: 'User1@Example.com',
      label: 'ChatGPT for user1',
      permissions: ['mail.read', 'mail.send', 'mail.delete'],
      mailboxPassword: 'imap-secret-value-123',
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as {
      connection: { id: string; mailbox: string };
      oneTimeCredential: { setupPassword: string };
    };
    expect(body.connection.mailbox).toBe('user1@example.com');
    const sent = ctx.control.calls.find((c) => c.method === 'createConnection')
      ?.args[0] as McpControlCreateConnectionRequest;
    const dms = createDmsDriver(
      loadConfig({}),
      createLogger({ level: 'silent' }),
      new FakeBrokerClient(),
    );
    const entry = (await dms.listMailboxes()).entries.find((e) => e.email === 'user1@example.com')!;
    expect(sent.mailboxFingerprint).toBe(
      mailboxIdentityFingerprint(entry.email, entry.passwordHash),
    );
    expect(sent.mailboxFingerprint).not.toContain(entry.passwordHash);
    expect(sent.actor).toBe(EMAIL);

    // Reading it back never includes the setup password.
    const detail = await call('GET', `/api/v1/mcp/connections/${body.connection.id}`);
    expect(detail.body).not.toContain(body.oneTimeCredential.setupPassword);

    // Audit row exists and holds no secret; logs hold no secret.
    const rows = ctx.db.all<{ action: string; details: string }>(
      "SELECT action, details FROM audit_log WHERE action LIKE 'mcp.%'",
    );
    expect(rows.map((r) => r.action)).toContain('mcp.connection_create');
    const everything = JSON.stringify(rows) + ctx.logLines.join('');
    expect(everything).not.toContain('imap-secret-value-123');
    expect(everything).not.toContain(body.oneTimeCredential.setupPassword);
  });

  it('passes apps/mcp errors through with their code (e.g. MCP disabled)', async () => {
    ctx.control.settings = { ...ctx.control.settings, enabled: false };
    const response = await call('POST', '/api/v1/mcp/connections', {
      mailbox: 'user1@example.com',
      label: 'x',
      permissions: ['mail.read'],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('accepts only sender identities that are aliases delivering to the mailbox', async () => {
    const created = (
      await call('POST', '/api/v1/mcp/connections', {
        mailbox: 'admin@example.com',
        label: 'x',
        permissions: ['mail.send'],
      })
    ).json() as {
      connection: { id: string };
    };
    const ok = await call('PATCH', `/api/v1/mcp/connections/${created.connection.id}`, {
      senderIdentities: ['postmaster@example.com'],
    });
    expect(ok.statusCode).toBe(200);
    const bad = await call('PATCH', `/api/v1/mcp/connections/${created.connection.id}`, {
      senderIdentities: ['newsletter@example.com'],
    });
    expect(bad.statusCode).toBe(400);
    const unrelated = await call('PATCH', `/api/v1/mcp/connections/${created.connection.id}`, {
      senderIdentities: ['ceo@bank.example'],
    });
    expect(unrelated.statusCode).toBe(400);
  });

  it('validates connection ids before calling apps/mcp (no path smuggling)', async () => {
    const response = await call('GET', '/api/v1/mcp/connections/..%2F..%2Fstatus');
    expect(response.statusCode).toBe(404);
    expect(ctx.control.calls.find((c) => c.method === 'getConnection')).toBeUndefined();
  });

  it('reissue/rotate responses are no-store and audited', async () => {
    const created = (
      await call('POST', '/api/v1/mcp/connections', {
        mailbox: 'user1@example.com',
        label: 'x',
        permissions: ['mail.read'],
      })
    ).json() as {
      connection: { id: string };
    };
    for (const path of ['reissue', 'rotate']) {
      const response = await call(
        'POST',
        `/api/v1/mcp/connections/${created.connection.id}/${path}`,
        {},
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const actions = ctx.db
      .all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'mcp.%'")
      .map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['mcp.connection_reissue', 'mcp.connection_rotate']),
    );
  });
});

describe('mailbox lifecycle hooks', () => {
  it('a password change through the panel notifies apps/mcp', async () => {
    const response = await call('PATCH', '/api/v1/mailboxes/user1@example.com/password', {
      password: 'a-brand-new-password-1',
    });
    expect(response.statusCode).toBe(200);
    expect(ctx.control.calls.find((c) => c.method === 'mailboxEvent')?.args[0]).toMatchObject({
      mailbox: 'user1@example.com',
      event: 'password_changed',
    });
  });

  it('a deletion through the panel revokes the mailbox’s MCP connections', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/mailboxes/user1@example.com',
      cookies: { [SESSION_COOKIE_NAME]: auth.token },
      headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: auth.csrfToken },
      payload: { mailData: 'keep' },
    });
    expect(response.statusCode).toBe(204);
    expect(ctx.control.calls.find((c) => c.method === 'mailboxEvent')?.args[0]).toMatchObject({
      mailbox: 'user1@example.com',
      event: 'deleted',
    });
  });

  it('an unreachable MCP service never fails the mailbox operation', async () => {
    vi.spyOn(ctx.control, 'mailboxEvent').mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const response = await call('PATCH', '/api/v1/mailboxes/user1@example.com/password', {
      password: 'another-new-password-2',
    });
    expect(response.statusCode).toBe(200);
  });
});
