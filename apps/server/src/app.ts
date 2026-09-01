/**
 * Fastify application wiring: security headers, the uniform error
 * handler, request-id propagation, the M2 health endpoint, and the M3
 * auth/session/admin routes (ARCHITECTURE.md §7.1, §7.2, §7.7).
 * `index.ts` owns the process lifecycle (starting, stopping, the
 * database) for the real, file-backed database it opens and migrates;
 * this module only builds the app. Callers that have no reason to care
 * about persistence (chiefly tests) may omit `db` entirely — see
 * {@link BuildAppOptions}.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Logger } from 'pino';
import { APP_VERSION, buildHelmetCspDirectives, HealthResponseSchema } from '@dwg/shared';
import type { AppConfig } from './platform/config.js';
import { AppError, createErrorHandler, generateId } from './platform/errors.js';
import { createDatabase, type Database } from './platform/db.js';
import { runMigrations, migrations } from './platform/migrations/index.js';
import { AdminsRepository } from './modules/auth/admins.repository.js';
import { SessionsRepository } from './modules/auth/sessions.repository.js';
import { LoginAttemptsRepository } from './modules/auth/login-attempts.repository.js';
import { AuthService } from './modules/auth/auth.service.js';
import { bootstrapFirstAdmin } from './modules/auth/bootstrap.js';
import { createAuthMiddleware } from './modules/auth/auth.middleware.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerAdminsRoutes } from './modules/auth/admins.routes.js';
import { createDmsDriver, type DmsDriver } from './drivers/dms/index.js';
import { registerMailCapabilitiesRoutes } from './modules/mail/capabilities.routes.js';
import { DomainsService } from './modules/mail/domains.service.js';
import { registerDomainsRoutes } from './modules/mail/domains.routes.js';
import { MailboxesService } from './modules/mail/mailboxes.service.js';
import { registerMailboxesRoutes } from './modules/mail/mailboxes.routes.js';
import { AliasesService } from './modules/mail/aliases.service.js';
import { registerAliasesRoutes } from './modules/mail/aliases.routes.js';
import { QuotasService } from './modules/mail/quotas.service.js';
import { registerQuotasRoutes } from './modules/mail/quotas.routes.js';
import { QueueService } from './modules/mail/queue.service.js';
import { registerQueueRoutes } from './modules/mail/queue.routes.js';
import {
  createDnsLookupPort,
  createDnsLookupPortFactory,
  type DnsLookupPort,
  type DnsLookupPortFactory,
} from './drivers/dns/index.js';
import { DnsService } from './modules/security/dns.service.js';
import { registerDnsRoutes } from './modules/security/dns.routes.js';
import { DkimService } from './modules/security/dkim.service.js';
import { registerDkimRoutes } from './modules/security/dkim.routes.js';
import { createTlsCertificateSource, type TlsCertificateSourcePort } from './drivers/tls/index.js';
import { TlsService } from './modules/security/tls.service.js';
import { registerTlsRoutes } from './modules/security/tls.routes.js';
import { createRspamdClient, type RspamdClientPort } from './drivers/rspamd/index.js';
import { RspamdService } from './modules/security/rspamd.service.js';
import { registerRspamdRoutes } from './modules/security/rspamd.routes.js';
import { startRspamdStatSampler } from './modules/security/rspamd-sampler.js';
import { Fail2banService } from './modules/security/fail2ban.service.js';
import { registerFail2banRoutes } from './modules/security/fail2ban.routes.js';
import { ClamavService } from './modules/security/clamav.service.js';
import { registerClamavRoutes } from './modules/security/clamav.routes.js';
import { SieveService } from './modules/security/sieve.service.js';
import { registerSieveRoutes } from './modules/security/sieve.routes.js';
import { AutoresponderService } from './modules/security/autoresponder.service.js';
import { registerAutoresponderRoutes } from './modules/security/autoresponder.routes.js';
import { createBrokerClient, type BrokerClient } from './drivers/broker/index.js';
import { ContainersService } from './modules/docker/containers.service.js';
import { registerContainersRoutes } from './modules/docker/containers.routes.js';
import { ImagesService } from './modules/docker/images.service.js';
import { registerImagesRoutes } from './modules/docker/images.routes.js';
import { VolumesService } from './modules/docker/volumes.service.js';
import { registerVolumesRoutes } from './modules/docker/volumes.routes.js';
import { NetworksService } from './modules/docker/networks.service.js';
import { registerNetworksRoutes } from './modules/docker/networks.routes.js';
import { LogsService } from './modules/docker/logs.service.js';
import { registerLogsRoutes } from './modules/docker/logs.routes.js';
import { MonitoringService } from './modules/docker/monitoring.service.js';
import { registerMonitoringRoutes } from './modules/docker/monitoring.routes.js';
import { HealthService } from './modules/docker/health.service.js';
import { registerDockerHealthRoutes } from './modules/docker/health.routes.js';
import { ConsoleService } from './modules/docker/console.service.js';
import { registerConsoleRoutes } from './modules/docker/console.routes.js';
import { JobsRepository } from './platform/jobs/jobs.repository.js';
import { createJobRunner, type JobRunner } from './platform/jobs/job-runner.js';
import { JobsService } from './modules/jobs/jobs.service.js';
import { registerJobsRoutes } from './modules/jobs/jobs.routes.js';
import { BackupsRepository } from './modules/backups/backups.repository.js';
import { BackupsService } from './modules/backups/backups.service.js';
import { registerBackupsRoutes } from './modules/backups/backups.routes.js';
import { BackupScheduleRepository } from './modules/backups/backup-schedule.repository.js';
import { BackupScheduleService } from './modules/backups/backup-schedule.service.js';
import { startBackupScheduler } from './modules/backups/backup-scheduler.js';
import { BackupDestinationConfigRepository } from './modules/backups/backup-destination-config.repository.js';
import { BackupDestinationConfigService } from './modules/backups/backup-destination-config.service.js';
import { DestinationService } from './modules/backups/destinations/destination.service.js';
import { BackupUploader, startBackupReconciler } from './modules/backups/backup-uploader.js';
import { registerBackupsAutomationRoutes } from './modules/backups/backups-automation.routes.js';
import { ConfigRepository } from './modules/config/config.repository.js';
import { ConfigService } from './modules/config/config.service.js';
import { registerConfigRoutes } from './modules/config/config.routes.js';
import { createRegistryClient, type RegistryClientPort } from './drivers/registry/index.js';
import { UpdatesService } from './modules/updates/updates.service.js';
import { registerUpdatesRoutes } from './modules/updates/updates.routes.js';
import { DashboardService } from './modules/dashboard/dashboard.service.js';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { NotificationsRepository } from './modules/notifications/notifications.repository.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { registerNotificationsRoutes } from './modules/notifications/notifications.routes.js';
import { startNotificationsEvaluator } from './modules/notifications/notifications-evaluator.js';

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /**
   * The application's database. Production startup (`index.ts`) always
   * passes the real, already-migrated database it owns and is
   * responsible for closing. When omitted, `buildApp` creates and
   * migrates a throwaway in-memory database itself and closes it when
   * the app does — convenient for tests (like this file's own) that
   * exercise no auth/data path and have no reason to care.
   */
  readonly db?: Database;
  /**
   * The `DmsDriver` every mail module (M7) is built on. When omitted,
   * `buildApp` calls {@link createDmsDriver} itself — real in production,
   * `FakeDmsDriver` otherwise (that function's own doc comment). Tests
   * that need a specific capability document (e.g. `ENABLE_QUOTAS`
   * disabled) or a hand-controlled driver pass one in directly, the same
   * way they pass `db` in above rather than only ever getting the
   * default.
   */
  readonly dmsDriver?: DmsDriver;
  /**
   * The `DnsLookupPort` every M8 security module built on DNS resolution
   * is wired to. Same override rationale as `dmsDriver` above — tests
   * that need specific DNS answers (or a resolver-failure simulation)
   * pass a hand-built `FakeDnsLookupPort` instead of the default
   * `createDnsLookupPort` selection.
   */
  readonly dnsLookupPort?: DnsLookupPort;
  /** Per-resolver-address factory for propagation checks (`drivers/dns/propagation.ts`) — defaults alongside `dnsLookupPort` when omitted. */
  readonly dnsLookupPortFactory?: DnsLookupPortFactory;
  /** Same override rationale as `dnsLookupPort`, for `TlsService` (`drivers/tls/index.ts`). */
  readonly tlsCertificateSource?: TlsCertificateSourcePort;
  /** Same override rationale as `dnsLookupPort`, for `RspamdService` (`drivers/rspamd/index.ts`). */
  readonly rspamdClient?: RspamdClientPort;
  /** Sampling cadence for `startRspamdStatSampler` — tests pass a short interval or omit entirely (the default is long enough never to fire during a test's lifetime). */
  readonly rspamdSampleIntervalMs?: number;
  /**
   * The `BrokerClient` every M9 Docker module is built on. Same override
   * rationale as `dmsDriver`/`dnsLookupPort` above — tests that need
   * specific broker behaviour (a container that fails to resolve, a
   * refused volume removal) pass a hand-built stub instead of the default
   * {@link createBrokerClient} selection (real in production, fixture-backed
   * `FakeBrokerClient` otherwise).
   */
  readonly brokerClient?: BrokerClient;
  /**
   * The one `JobRunner` every M10 module (backups/restore today) enqueues
   * work on. Same override rationale as `brokerClient` above — a test that
   * wants to inspect job state mid-run, or avoid startup recovery's log
   * line, passes its own instance instead of the default `createJobRunner`
   * selection, which always runs recovery against whichever `db` this call
   * received.
   */
  readonly jobRunner?: JobRunner;
  /** Same override rationale as `brokerClient` — tests that need a specific registry answer (an update available, a mismatched digest, an unreachable registry) pass a hand-built stub instead of the default {@link createRegistryClient} selection (real in production, fixture-backed `FakeRegistryClient` otherwise). */
  readonly registryClient?: RegistryClientPort;
  /** Same override rationale as `rspamdSampleIntervalMs` — the default is long enough never to fire during a test's lifetime. */
  readonly notificationsEvaluateIntervalMs?: number;
  /** Cadence for the scheduled-backup tick (M13). Tests omit it; the default checks often enough to fire a due backup promptly, but every tick is a no-op unless a schedule is enabled. */
  readonly backupSchedulerIntervalMs?: number;
  /** Cadence for the background remote-reconcile sweep (M13). Same override rationale; a no-op unless a destination is configured and auto-upload is on. */
  readonly backupReconcileIntervalMs?: number;
}

const REQUEST_ID_HEADER = 'request-id';

/**
 * Security headers (SECURITY.md §4.2). The CSP directives come from
 * `@dwg/shared`'s `buildHelmetCspDirectives()` — the one place this
 * policy is defined, rather than a second hand-copy of SECURITY.md §4.2
 * that could drift from it. M12 verified this exact policy against the
 * real, built SPA in a real browser — see `e2e/security/csp.spec.ts` for
 * the harness and result.
 */
async function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: buildHelmetCspDirectives(),
    },
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    // Opt-out for plain-HTTP LAN installs (SECURITY.md §4.2, ENABLE_HSTS).
    hsts: config.enableHsts
      ? { maxAge: 15_552_000, includeSubDomains: true, preload: false }
      : false,
  });

  // helmet in this major version dropped built-in Permissions-Policy
  // support (the spec churned too much); set it directly. Deny every
  // feature this admin panel has no use for.
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header(
      'permissions-policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
    done(null, payload);
  });
}

/** Reflects the (inbound-or-generated) request ID back to the client so it can be quoted alongside an `errorId`. */
function registerRequestIdPropagation(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });
}

/** A request path this server owns as an API route (or the health check), never a client-side SPA route — the boundary the SPA-fallback 404 handler below must not cross, or a genuinely wrong API URL would silently render the app shell instead of a JSON 404. */
function isApiPath(request: FastifyRequest): boolean {
  return request.url.startsWith('/api/');
}

/**
 * Registers `@fastify/static` for the built SPA (`config.staticDir` —
 * M13, ARCHITECTURE.md §4, §10) when one is configured, and returns the
 * one `setNotFoundHandler` callback `buildApp` should install either
 * way. Fastify allows exactly one `setNotFoundHandler` call per instance
 * — a second call throws "Not found handler already set" — so this
 * builds a single handler that branches internally rather than layering
 * a static-only override on top of the plain JSON one, the way two
 * separate calls would need to.
 *
 * `wildcard: false`: `@fastify/static` otherwise registers its own
 * catch-all `GET /*` route, which would intercept an unmatched request
 * *before* the not-found handler ever ran — exactly the hook a
 * client-side route (`/mail/domains`, a browser refresh on any SPA
 * route) needs to reach, since there is no file on disk at that path to
 * serve directly. `jsonNotFound` is `buildApp`'s own JSON-envelope 404
 * handler, called for `/api/*` and non-GET/HEAD requests either way, so
 * an API 404 looks identical whether or not static serving is on.
 */
async function buildNotFoundHandler(
  app: FastifyInstance,
  staticDir: string | null,
  jsonNotFound: (request: FastifyRequest, reply: FastifyReply) => void,
): Promise<(request: FastifyRequest, reply: FastifyReply) => void> {
  if (staticDir === null) {
    return jsonNotFound;
  }

  await app.register(fastifyStatic, { root: staticDir, wildcard: false });

  return (request, reply) => {
    if (isApiPath(request) || (request.method !== 'GET' && request.method !== 'HEAD')) {
      jsonNotFound(request, reply);
      return;
    }
    void reply.sendFile('index.html', staticDir);
  };
}

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/v1/health', (_request, reply) => {
    const body = HealthResponseSchema.parse({
      status: 'ok',
      version: APP_VERSION,
      uptime: process.uptime(),
    });
    void reply.send(body);
  });
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, logger } = options;

  const ownsDb = options.db === undefined;
  const db = options.db ?? createDatabase(':memory:');
  if (ownsDb) {
    runMigrations(db, migrations);
  }

  const admins = new AdminsRepository(db);
  const sessions = new SessionsRepository(db);
  const attempts = new LoginAttemptsRepository(db);
  const authService = new AuthService({ db, admins, sessions, attempts, config });

  // Idempotent (bootstrap.ts): a no-op once any admin row exists, so
  // calling this unconditionally on every build is safe and is what
  // makes it actually run on the one build that matters (a fresh
  // database), rather than needing a separate "is this the first ever
  // start" signal.
  await bootstrapFirstAdmin({ db, admins, config, logger });

  // Pin the Logger generic to Fastify's own FastifyBaseLogger interface
  // instead of letting it infer the concrete pino.Logger type from
  // `loggerInstance`. A real pino logger satisfies that interface fine
  // (it's a superset), but leaving the instance's type over-specialized
  // to pino.Logger breaks assignability against plugins like
  // @fastify/helmet that are written against the generic interface.
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    // Trust an inbound `request-id` header from a reverse proxy; fall
    // back to our own ULID-style generator (sortable, collision
    // resistant across restarts) rather than Fastify's default
    // in-process counter.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: () => generateId('req'),
  });

  // Whoever created the database is who closes it: index.ts owns and
  // closes the real one, so this only ever fires for the throwaway
  // in-memory database this function created for itself above.
  if (ownsDb) {
    app.addHook('onClose', () => {
      db.close();
    });
  }

  const errorHandler = createErrorHandler(logger);
  app.setErrorHandler(errorHandler);
  // Route requests that don't match any registered route through the
  // same uniform envelope, rather than Fastify's own default 404 body —
  // every response under /api/v1 (and every other path) should have one
  // consistent error shape (ARCHITECTURE.md §7.1), not "usually our
  // envelope, except when the path is simply wrong." The actual
  // `setNotFoundHandler` call happens once, near the end of this
  // function via `buildNotFoundHandler` — Fastify allows exactly one per
  // instance, and whether static-SPA serving is on changes what that one
  // handler does, not whether this JSON shape exists for `/api/*`.
  const jsonNotFoundHandler = (request: FastifyRequest, reply: FastifyReply) => {
    errorHandler(new AppError('NOT_FOUND', 'That route does not exist.'), request, reply);
  };

  await registerSecurityHeaders(app, config);
  registerRequestIdPropagation(app);
  await app.register(fastifyCookie);

  const middleware = createAuthMiddleware(app, { authService, config });

  // One `BrokerClient` for the whole application. Constructed here, ahead
  // of the mail services, because since M16 the DMS driver reaches
  // docker-mailserver *through* it — every mail write is a named broker
  // operation now, not an argv this tier assembles.
  const brokerClient = options.brokerClient ?? createBrokerClient(config, logger);

  // M7 — mail management (FEATURE_MATRIX.md §2–§7). One DmsDriver instance
  // shared by every mail service, mirroring how `admins`/`sessions`/
  // `attempts` are each constructed once above and handed to whichever
  // service needs them — see `createDmsDriver`'s own doc comment for how
  // real vs fake is selected.
  const dmsDriver = options.dmsDriver ?? createDmsDriver(config, logger, brokerClient);
  const domainsService = new DomainsService(dmsDriver);
  const mailboxesService = new MailboxesService(dmsDriver);
  const aliasesService = new AliasesService(dmsDriver);
  const quotasService = new QuotasService(dmsDriver);
  const queueService = new QueueService(dmsDriver);

  // M8 — DNS diagnostics (FEATURE_MATRIX.md §10). Mirrors the DMS driver
  // wiring above: one resolver (plus its per-address factory for
  // propagation checks) shared by the one service that needs it.
  const dnsLookupPort = options.dnsLookupPort ?? createDnsLookupPort(config, logger);
  const dnsLookupPortFactory =
    options.dnsLookupPortFactory ?? createDnsLookupPortFactory(config, logger);
  const dnsService = new DnsService(dnsLookupPort, dnsLookupPortFactory);
  const dkimService = new DkimService(dmsDriver, dnsLookupPort);

  // M8 — TLS certificate status (FEATURE_MATRIX.md §12). Checks the DMS
  // container's own configured hostname, never an admin-supplied one.
  const tlsCertificateSource =
    options.tlsCertificateSource ?? createTlsCertificateSource(config, logger);
  const tlsService = new TlsService(dmsDriver, tlsCertificateSource, config.dms.containerName);

  // M8 — Rspamd (FEATURE_MATRIX.md §13-15). The sampler is started
  // unconditionally (it capability-gates itself every tick, `rspamd-sampler.ts`)
  // and its timer is `.unref()`d plus stopped on `onClose`, so it never
  // keeps a process — or a test's harness — alive on its own.
  const rspamdClient = options.rspamdClient ?? createRspamdClient(config, logger);
  const rspamdService = new RspamdService(dmsDriver, rspamdClient, db);
  const rspamdSampler = startRspamdStatSampler(
    { db, dmsDriver, rspamdClient, logger },
    options.rspamdSampleIntervalMs,
  );
  app.addHook('onClose', () => {
    rspamdSampler.stop();
  });

  // M8 — Fail2ban (`docs/research/03-mail-stack-components.md` §10).
  const fail2banService = new Fail2banService(dmsDriver);

  // M8 — ClamAV (FEATURE_MATRIX.md §16).
  const clamavService = new ClamavService(dmsDriver);

  // M8 — Sieve filters (FEATURE_MATRIX.md §17).
  const sieveService = new SieveService(dmsDriver);

  // M8 — Autoresponder (FEATURE_MATRIX.md §18). Built entirely on
  // `sieveService`'s own put/activate/deactivate — see that service's doc
  // comment for why there is no separate persistence layer.
  const autoresponderService = new AutoresponderService(dmsDriver);

  // M9 — Docker & observability (FEATURE_MATRIX.md §24-26, §32). The one
  // `BrokerClient` these modules share is constructed above, before the
  // mail services, because M16 made `dmsDriver` depend on it too.
  // `ConsoleService` alone also takes `config.enableExecConsole` — the one
  // flag-gated module in this group (AGENT_BRIEF.md §4: "off by default").
  const containersService = new ContainersService(brokerClient);
  const imagesService = new ImagesService(brokerClient);
  const volumesService = new VolumesService(brokerClient);
  const networksService = new NetworksService(brokerClient);
  const logsService = new LogsService(brokerClient);
  const monitoringService = new MonitoringService(brokerClient);
  const healthService = new HealthService(brokerClient);
  const consoleService = new ConsoleService(brokerClient, config.enableExecConsole);

  // M10 — jobs, backups, restore, config editor, updates
  // (IMPLEMENTATION_PLAN.md §2.1-§2.2). One `JobRunner` shared by every
  // module that enqueues long-running work, mirroring `brokerClient`/
  // `dmsDriver` above — see `platform/jobs/job-runner.ts` for why it runs
  // strictly one job at a time.
  const jobsRepository = new JobsRepository(db);
  const jobRunner = options.jobRunner ?? createJobRunner(jobsRepository, logger);
  const jobsService = new JobsService(jobsRepository, jobRunner);

  // Backups/restore (IMPLEMENTATION_PLAN.md §2.1) — built on the same
  // `jobRunner`/`brokerClient` constructed above.
  const backupsRepository = new BackupsRepository(db);
  const backupsService = new BackupsService(
    backupsRepository,
    jobRunner,
    brokerClient,
    config.backupDir,
  );

  // M13 — scheduled backups + remote destinations. The schedule and the
  // destination config are live DB rows re-read on every use, so both survive a
  // restart and take effect immediately. The uploader reads the destination
  // through the factory (so a mid-session config change is picked up) and the
  // retention numbers from the schedule row.
  const backupScheduleRepository = new BackupScheduleRepository(db);
  const backupScheduleService = new BackupScheduleService(backupScheduleRepository);
  const backupDestinationConfigRepository = new BackupDestinationConfigRepository(db);
  const backupDestinationConfigService = new BackupDestinationConfigService(
    backupDestinationConfigRepository,
    db,
  );
  const destinationService = new DestinationService({
    resolve: () => backupDestinationConfigService.resolve(),
  });
  const backupUploader = new BackupUploader({
    db,
    backupsRepository,
    destinationProvider: () => destinationService.current(),
    retentionPolicy: () => {
      const schedule = backupScheduleRepository.get();
      return { keep: schedule.retentionKeep, maxAgeDays: schedule.retentionMaxAgeDays };
    },
    backupDir: config.backupDir,
    logger,
  });

  // Re-armed from the DB on every startup (both timers are `.unref()`d and
  // stopped on close): the scheduler fires due backups, the reconciler sweeps
  // local backups to the remote when auto-upload is on. Each tick is a no-op
  // until the operator enables the corresponding feature.
  const backupScheduler = startBackupScheduler(
    { db, scheduleRepository: backupScheduleRepository, backupsService, logger },
    options.backupSchedulerIntervalMs,
  );
  app.addHook('onClose', () => {
    backupScheduler.stop();
  });
  const backupReconciler = startBackupReconciler(
    {
      uploader: backupUploader,
      enabled: () => backupScheduleRepository.get().uploadToRemote,
      logger,
    },
    options.backupReconcileIntervalMs,
  );
  app.addHook('onClose', () => {
    backupReconciler.stop();
  });

  // Config/environment editor (FEATURE_MATRIX.md §28-29).
  const configRepository = new ConfigRepository(db);
  const configService = new ConfigService(configRepository, db, config);

  // Updates (IMPLEMENTATION_PLAN.md §2.2) — comparison only; see
  // `modules/updates/updates.service.ts`'s header for why apply is
  // deferred.
  const registryClient = options.registryClient ?? createRegistryClient(config, logger);
  const updatesService = new UpdatesService(brokerClient, registryClient, backupsRepository);

  // M11 — dashboard, command palette, global search, notifications
  // (IMPLEMENTATION_PLAN.md §3). `DashboardService` composes every
  // service constructed above; it is deliberately built last, after all
  // of them exist, and is itself the one thing `NotificationsService`'s
  // evaluator is built on — see that module's own header for why there is
  // no second reading of "is TLS okay" anywhere in this file.
  const dashboardService = new DashboardService(
    dmsDriver,
    healthService,
    monitoringService,
    tlsService,
    rspamdService,
    clamavService,
    fail2banService,
    backupsRepository,
    updatesService,
    db,
  );

  const notificationsRepository = new NotificationsRepository(db);
  const notificationsService = new NotificationsService(notificationsRepository);
  const notificationsEvaluator = startNotificationsEvaluator(
    { repository: notificationsRepository, dashboardService, logger },
    options.notificationsEvaluateIntervalMs,
  );
  app.addHook('onClose', () => {
    notificationsEvaluator.stop();
  });

  registerHealthRoute(app);
  await registerAuthRoutes(app, { authService, config, middleware });
  await registerAdminsRoutes(app, { db, admins, middleware });
  await registerMailCapabilitiesRoutes(app, { driver: dmsDriver, middleware });
  await registerDomainsRoutes(app, { domainsService, middleware });
  await registerMailboxesRoutes(app, { db, mailboxesService, middleware });
  await registerAliasesRoutes(app, { db, aliasesService, middleware });
  await registerQuotasRoutes(app, { quotasService, middleware });
  await registerQueueRoutes(app, { queueService, middleware });
  await registerDnsRoutes(app, { dnsService, middleware });
  await registerDkimRoutes(app, { db, dkimService, middleware });
  await registerTlsRoutes(app, { tlsService, middleware });
  await registerRspamdRoutes(app, { db, rspamdService, middleware });
  await registerFail2banRoutes(app, { db, fail2banService, middleware });
  await registerClamavRoutes(app, { db, clamavService, middleware });
  await registerSieveRoutes(app, { db, sieveService, middleware });
  await registerAutoresponderRoutes(app, { db, autoresponderService, middleware });
  await registerContainersRoutes(app, { db, containersService, middleware });
  await registerImagesRoutes(app, { db, imagesService, middleware });
  await registerVolumesRoutes(app, { db, volumesService, middleware });
  await registerNetworksRoutes(app, { networksService, middleware });
  await registerLogsRoutes(app, { logsService, middleware });
  await registerMonitoringRoutes(app, { monitoringService, middleware });
  await registerDockerHealthRoutes(app, { healthService, middleware });
  await registerConsoleRoutes(app, { db, consoleService, middleware });
  await registerJobsRoutes(app, { db, jobsService, middleware });
  await registerBackupsRoutes(app, { db, backupsService, middleware });
  await registerBackupsAutomationRoutes(app, {
    db,
    scheduleService: backupScheduleService,
    destinationConfigService: backupDestinationConfigService,
    destinationService,
    uploader: backupUploader,
    backupsRepository,
    jobRunner,
    middleware,
  });
  await registerConfigRoutes(app, { db, configService, middleware });
  await registerUpdatesRoutes(app, { db, updatesService, middleware });
  await registerDashboardRoutes(app, { dashboardService, middleware });
  await registerNotificationsRoutes(app, { notificationsService, middleware });

  // The one `setNotFoundHandler` call this instance is allowed — see
  // `buildNotFoundHandler`'s own doc comment for why static-SPA serving
  // (or not) has to be decided inside a single handler rather than two
  // layered `setNotFoundHandler` calls.
  app.setNotFoundHandler(await buildNotFoundHandler(app, config.staticDir, jsonNotFoundHandler));

  return app;
}
