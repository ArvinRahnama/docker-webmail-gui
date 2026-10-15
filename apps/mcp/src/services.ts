/**
 * Composition root: builds every repository and service from config, the
 * database and the injectable ports (mail backend, metadata fetcher, clock).
 * Tests construct this directly with fakes; index.ts with the real ports.
 */
import type { Logger } from 'pino';
import type { McpConfig } from './config.js';
import type { Database } from './platform/db.js';
import { systemClock, type Clock } from './platform/clock.js';
import { CredentialVault } from './crypto/vault.js';
import { SettingsRepository } from './store/settings.repository.js';
import { BindingsRepository } from './store/bindings.repository.js';
import { ConnectionsRepository } from './store/connections.repository.js';
import { OAuthRepository } from './store/oauth.repository.js';
import { OperationsRepository } from './store/operations.repository.js';
import { McpAuditLog } from './domain/audit.js';
import { ConnectionsService } from './domain/connections.service.js';
import { ClientsService } from './oauth/clients.service.js';
import { TokensService } from './oauth/tokens.service.js';
import { AuthorizationService } from './oauth/authorization.service.js';
import { BearerVerifier } from './oauth/bearer.js';
import { safeFetchJson, type MetadataFetcher } from './oauth/safe-fetch.js';
import { ToolRateLimiter, type ToolDeps } from './mcp/tools.js';
import type { MailBackend } from './mail/types.js';

export interface Services {
  readonly config: McpConfig;
  readonly db: Database;
  readonly clock: Clock;
  readonly vault: CredentialVault;
  readonly settings: SettingsRepository;
  readonly bindings: BindingsRepository;
  readonly connectionsRepo: ConnectionsRepository;
  readonly oauth: OAuthRepository;
  readonly operations: OperationsRepository;
  readonly audit: McpAuditLog;
  readonly connections: ConnectionsService;
  readonly clients: ClientsService;
  readonly tokens: TokensService;
  readonly authorization: AuthorizationService;
  readonly bearer: BearerVerifier;
  readonly mail: MailBackend;
  readonly toolDeps: ToolDeps;
  readonly startedAt: Date;
}

export interface BuildServicesOptions {
  readonly config: McpConfig;
  readonly db: Database;
  readonly logger: Logger;
  readonly mail: MailBackend;
  readonly fetcher?: MetadataFetcher;
  readonly clock?: Clock;
}

export function buildServices(options: BuildServicesOptions): Services {
  const { config, db, logger, mail } = options;
  const clock = options.clock ?? systemClock;
  const vault = new CredentialVault(config.vaultKey);
  const settings = new SettingsRepository(db, {
    publicBaseUrl: config.publicUrlSeed,
    mailHost: config.mailHostSeed,
  });
  const bindings = new BindingsRepository(db);
  const connectionsRepo = new ConnectionsRepository(db);
  const oauth = new OAuthRepository(db);
  const operations = new OperationsRepository(db);
  const audit = new McpAuditLog(db, () => clock.now());
  const connections = new ConnectionsService({
    db,
    bindings,
    connections: connectionsRepo,
    oauth,
    settings,
    vault,
    mail,
    audit,
    clock,
  });
  const clients = new ClientsService({
    repo: oauth,
    settings,
    fetcher: options.fetcher ?? safeFetchJson,
    audit,
    clock,
  });
  const tokens = new TokensService({
    repo: oauth,
    connectionsRepo,
    connections,
    settings,
    audit,
    clock,
  });
  const authorization = new AuthorizationService({
    db,
    settings,
    clients,
    tokens,
    oauth,
    connectionsRepo,
    bindings,
    connections,
    audit,
    clock,
    requireHttps: config.requireHttps,
  });
  const bearer = new BearerVerifier({
    settings,
    connectionsRepo,
    bindings,
    oauth,
    connections,
    audit,
    clock,
  });
  const toolDeps: ToolDeps = {
    mail,
    settings,
    bindings,
    connections,
    operations,
    audit,
    clock,
    limiter: new ToolRateLimiter(clock),
    logger,
    version: config.version,
  };
  return {
    config,
    db,
    clock,
    vault,
    settings,
    bindings,
    connectionsRepo,
    oauth,
    operations,
    audit,
    connections,
    clients,
    tokens,
    authorization,
    bearer,
    mail,
    toolDeps,
    startedAt: clock.now(),
  };
}
