/**
 * The MCP integration embedded in the server process, with nothing faked
 * between the panel and it: the real in-process control client, the real
 * MCP component (fake mail backend only), its own public listener on a real
 * port, and the panel's real routes and mailbox lifecycle hooks.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { McpConfigError } from '@dwg/mcp';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logger.js';
import { AdminsRepository } from '../auth/admins.repository.js';
import { hashPassword } from '../auth/password.js';
import { SESSION_COOKIE_NAME } from '../auth/auth.middleware.js';
import { loginAs, SAME_ORIGIN_HEADERS } from '../mail/mail-test-harness.js';
import { startMcpIntegration, type McpIntegration } from './embedded.js';

const EMAIL = 'postmaster-admin@example.com';
const PASSWORD = 'correct-horse-battery-staple';
const MAILBOX = 'user1@example.com'; // seeded by the fake DMS driver
const silent = () => createLogger({ level: 'silent' });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('embedded MCP integration', () => {
  it('starts nothing when MCP_ENABLED is off', async () => {
    expect(
      await startMcpIntegration(loadConfig({ MCP_ENABLED: 'false' }), silent(), {}),
    ).toBeNull();
  });

  it('is on by default', () => {
    expect(loadConfig({}).mcp.enabled).toBe(true);
  });

  function productionConfig(dir: string) {
    return loadConfig({
      APP_MODE: 'production',
      COOKIE_SECRET: 'c'.repeat(32),
      BROKER_SHARED_SECRET: 'b'.repeat(32),
      DATA_DIR: dir,
      BACKUP_DIR: join(dir, 'backups'),
    });
  }

  it('generates a vault key once in production when none is configured, and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwg-mcp-embedded-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const keyPath = join(dir, 'mcp', 'vault.key');

    const first = (await startMcpIntegration(productionConfig(dir), silent(), {
      APP_MODE: 'production',
    })) as McpIntegration;
    await first.mcp.close();
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const key = readFileSync(keyPath, 'utf8');
    expect(first.mcp.config.vaultKey?.toString('hex')).toBe(key.trim());

    const second = (await startMcpIntegration(productionConfig(dir), silent(), {
      APP_MODE: 'production',
    })) as McpIntegration;
    await second.mcp.close();
    expect(readFileSync(keyPath, 'utf8')).toBe(key);
    expect(second.mcp.config.vaultKey?.equals(first.mcp.config.vaultKey as Buffer)).toBe(true);
  });

  it('refuses to start in production when no key is configured and none can be generated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwg-mcp-embedded-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const notADirectory = join(dir, 'file');
    writeFileSync(notADirectory, '');
    await expect(
      startMcpIntegration(productionConfig(dir), silent(), {
        APP_MODE: 'production',
        MCP_DATA_DIR: join(notADirectory, 'mcp'),
      }),
    ).rejects.toBeInstanceOf(McpConfigError);
  });

  it('panel → in-process MCP: issue a connection, serve OAuth discovery, and suspend it on a password change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwg-mcp-embedded-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      DATA_DIR: dir,
      BACKUP_DIR: join(dir, 'backups'),
      MCP_ENABLED: 'true',
    });

    const integration = (await startMcpIntegration(config, silent(), {
      MCP_VAULT_KEY: 'f'.repeat(64),
      MCP_PUBLIC_HOST: '127.0.0.1',
      MCP_PUBLIC_PORT: String(port),
      LOG_LEVEL: 'silent',
    })) as McpIntegration;
    expect(integration).not.toBeNull();
    cleanups.push(() => integration.mcp.close());
    expect(integration.mcp.config.dataDir).toBe(join(dir, 'mcp'));
    await integration.mcp.listen();

    const db: Database = createDatabase(':memory:');
    runMigrations(db, migrations);
    cleanups.push(() => db.close());
    new AdminsRepository(db).create({
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      role: 'administrator',
      forcePasswordChange: false,
    });
    const app: FastifyInstance = await buildApp({
      config,
      logger: silent(),
      db,
      mcpControlClient: integration.client,
    });
    cleanups.push(() => app.close());
    const auth = await loginAs(app, EMAIL, PASSWORD);
    const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        cookies: { [SESSION_COOKIE_NAME]: auth.token },
        headers: { ...SAME_ORIGIN_HEADERS, [CSRF_HEADER_NAME]: auth.csrfToken },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });

    const status = await call('GET', '/api/v1/mcp/status');
    expect(status.json()).toMatchObject({ deployed: true, service: { enabled: false } });

    const settings = await call('PATCH', '/api/v1/mcp/settings', {
      enabled: true,
      publicBaseUrl: base,
    });
    expect(settings.statusCode).toBe(200);

    const created = await call('POST', '/api/v1/mcp/connections', {
      mailbox: MAILBOX,
      label: 'Embedded',
      permissions: ['mail.read'],
      mailboxPassword: 'the-mailbox-password',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      connection: { id: string; mcpUrl: string; credentialHealth: string };
      oneTimeCredential: { setupPassword: string };
    };
    expect(body.connection.mcpUrl).toBe(`${base}/mcp/${body.connection.id}`);
    expect(body.connection.credentialHealth).toBe('healthy');
    expect(JSON.stringify(body)).not.toContain('the-mailbox-password');

    // The MCP listener is a separate port in this same process.
    const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    expect(((await metadata.json()) as { issuer: string }).issuer).toBe(base);
    const unauthenticated = await fetch(body.connection.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain('resource_metadata=');
    // The panel's API is not reachable on the MCP port, and vice versa.
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/oauth/authorize' })).statusCode).not.toBe(200);

    // Mailbox lifecycle hook, end to end: password change → suspended.
    const changed = await call(
      'PATCH',
      `/api/v1/mailboxes/${encodeURIComponent(MAILBOX)}/password`,
      {
        password: 'a-brand-new-mailbox-password',
      },
    );
    expect(changed.statusCode).toBe(200);
    const after = await call('GET', `/api/v1/mcp/connections/${body.connection.id}`);
    expect(after.json()).toMatchObject({
      connection: { status: 'suspended', credentialHealth: 'stale' },
    });
  });
});
