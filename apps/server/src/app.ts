/**
 * Fastify application wiring: security headers, the uniform error
 * handler, request-id propagation, and the M2 health endpoint
 * (ARCHITECTURE.md §7.1, §7.7). `index.ts` owns the process lifecycle
 * (starting, stopping, the database); this module only builds the app.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import type { Logger } from 'pino';
import { APP_VERSION, HealthResponseSchema } from '@dwg/shared';
import type { AppConfig } from './platform/config.js';
import { AppError, createErrorHandler, generateId } from './platform/errors.js';

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
}

const REQUEST_ID_HEADER = 'request-id';

/**
 * Security headers (SECURITY.md §4.2). The CSP below matches that
 * section's directives directly. Final tuning against the *built* SPA
 * (e.g. any hashes/nonces Vite output ends up needing) is explicitly
 * IMPLEMENTATION_PLAN.md M12's job, once there is a real frontend bundle
 * to tune it against — this is the strict baseline until then.
 */
async function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
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

  const errorHandler = createErrorHandler(logger);
  app.setErrorHandler(errorHandler);
  // Route requests than don't match any registered route through the
  // same uniform envelope, rather than Fastify's own default 404 body —
  // every response under /api/v1 (and every other path) should have one
  // consistent error shape (ARCHITECTURE.md §7.1), not "usually our
  // envelope, except when the path is simply wrong."
  app.setNotFoundHandler((request, reply) => {
    errorHandler(new AppError('NOT_FOUND', 'That route does not exist.'), request, reply);
  });

  await registerSecurityHeaders(app, config);
  registerRequestIdPropagation(app);
  registerHealthRoute(app);

  return app;
}
