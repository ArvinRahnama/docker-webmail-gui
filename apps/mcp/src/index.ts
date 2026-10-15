/**
 * The MCP integration as an in-process component of the panel's server
 * (docs/mcp-integration.md). The server calls `startEmbeddedMcp` when
 * `MCP_ENABLED=true`; there is no separate MCP process or container.
 *
 * Lifecycle: database → migrations → services → the public listener (OAuth
 * + MCP, on its own port so its headers, cookies and CSP never mix with the
 * panel's) → housekeeping timer. The control API is built but never bound
 * to a socket: `control()` reaches it in-process, and every call still
 * passes its own authentication and Zod validation.
 */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { MCP_CONTROL_AUTH_HEADER } from '@dwg/shared';
import type { McpConfig } from './config.js';
import { createMcpLogger } from './platform/logger.js';
import { openMcpDatabase } from './platform/db.js';
import { migrations, runMigrations } from './platform/migrations/index.js';
import { buildServices } from './services.js';
import { buildPublicApp } from './public/public-app.js';
import { buildControlApp } from './control/control-app.js';
import { ImapSmtpMailBackend } from './mail/imap-smtp-backend.js';
import { FakeMailBackend } from './mail/fake-backend.js';
import { addSeconds } from './platform/clock.js';

export { loadMcpConfig, McpConfigError, MCP_CONFIG_ENV_KEYS, type McpConfig } from './config.js';

const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

/** One control API call, already authenticated; the body is the raw JSON response text. */
export type McpControlTransport = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<{ readonly status: number; readonly text: string }>;

export interface EmbeddedMcp {
  readonly config: McpConfig;
  /** In-process control API (`/control/v1` + path). */
  readonly control: McpControlTransport;
  /** Binds the public OAuth + MCP listener; resolves with its address. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface StartEmbeddedMcpOptions {
  readonly config: McpConfig;
  /** Defaults to the MCP logger (stdout, with its own redaction list). */
  readonly logger?: Logger;
}

export async function startEmbeddedMcp(options: StartEmbeddedMcpOptions): Promise<EmbeddedMcp> {
  const { config } = options;
  const logger = (options.logger ?? createMcpLogger({ level: config.logLevel })).child({
    component: 'mcp',
  });
  for (const warning of config.warnings) logger.warn(warning);

  const db = openMcpDatabase(config.dataDir);
  runMigrations(db, migrations);

  const mail =
    config.mailBackend === 'fake'
      ? new FakeMailBackend({ seed: true })
      : new ImapSmtpMailBackend({ tlsCa: config.mailTlsCa, logger });
  logger.info({ mailBackend: mail.kind }, 'MCP mail backend selected');

  const services = buildServices({ config, db, logger, mail });
  const publicApp: FastifyInstance = await buildPublicApp(
    services,
    logger.child({ listener: 'mcp-public' }),
  );
  const controlApp: FastifyInstance = await buildControlApp(
    services,
    logger.child({ listener: 'mcp-control' }),
  );

  const housekeeping = (): void => {
    try {
      const now = services.clock.now();
      services.oauth.purgeExpired(addSeconds(now, -86_400).toISOString());
      const retention = services.settings.get().auditRetentionDays;
      services.audit.purgeOlderThan(addSeconds(now, -retention * 86_400).toISOString());
    } catch (err) {
      logger.error({ err }, 'MCP housekeeping failed');
    }
  };
  housekeeping();
  const timer = setInterval(housekeeping, HOUSEKEEPING_INTERVAL_MS);
  timer.unref();

  let closed = false;
  return {
    config,
    control: async (method, path, body) => {
      const response = await controlApp.inject({
        method,
        url: `/control/v1${path}`,
        headers: {
          [MCP_CONTROL_AUTH_HEADER]: config.controlSecret,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
      return { status: response.statusCode, text: response.body };
    },
    listen: async () => {
      const address = await publicApp.listen({
        host: config.publicListener.host,
        port: config.publicListener.port,
      });
      logger.info({ address }, 'MCP public listener ready');
      return address;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await Promise.allSettled([publicApp.close(), controlApp.close()]);
      db.close();
    },
  };
}
