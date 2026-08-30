/**
 * Fastify application wiring for the broker (ARCHITECTURE.md §6, §11;
 * SECURITY.md §4.1). One route, one auth gate, one closed vocabulary —
 * this file is short on purpose, because everything in it runs with
 * access to the Docker socket.
 *
 * Request handling order matters, and rejection happens before any
 * parsing at all: the shared-secret guard is registered as an `onRequest`
 * hook, which Fastify runs *before*
 * its `preParsing`/body-parsing lifecycle steps
 * (https://fastify.dev/docs/latest/Reference/Lifecycle/) — an
 * unauthenticated caller's body is never even handed to the JSON parser,
 * let alone to Zod.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { BROKER_OPS_PATH, BROKER_RESPONSE_SCHEMAS, BrokerRequestSchema } from '@dwg/shared';
import type { BrokerConfig } from './config.js';
import type { DockerApi } from './docker-types.js';
import { createSecretGuard } from './auth.js';
import { BrokerError, createBrokerErrorHandler } from './errors.js';
import { handleOperation, type OperationDeps } from './operations.js';
import { registerArchiveRoutes } from './archive-routes.js';

export interface BuildBrokerAppOptions {
  readonly config: BrokerConfig;
  readonly logger: Logger;
  readonly docker: DockerApi;
}

/** Operation bodies are a handful of small fields at most; bounding request size costs nothing and is cheap defence-in-depth regardless of any upstream limit. */
const MAX_BODY_BYTES = 65_536;

export function buildBrokerApp(options: BuildBrokerAppOptions): FastifyInstance {
  const { config, logger, docker } = options;

  // Pin the Logger generic to Fastify's own FastifyBaseLogger interface
  // instead of letting it infer the concrete pino.Logger type from
  // `loggerInstance` — mirrors apps/server/src/app.ts's identical fix. A
  // real pino logger satisfies FastifyBaseLogger fine (it's a superset);
  // leaving the instance's type over-specialised to pino.Logger is what
  // breaks assignability, not anything about the broker's own routes.
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    bodyLimit: MAX_BODY_BYTES,
  });

  const errorHandler = createBrokerErrorHandler(logger);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => {
    errorHandler(new BrokerError('NOT_FOUND', 'That route does not exist.'), request, reply);
  });

  app.post(
    BROKER_OPS_PATH,
    { onRequest: [createSecretGuard(config.sharedSecret)] },
    async (request, reply) => {
      // Unknown operation name and a well-formed operation carrying an
      // unexpected extra field are both rejected right here, by the same
      // call: BrokerRequestSchema is a discriminated union of `.strict()`
      // per-operation schemas, so a body outside the enum matches no
      // member, and a body with an extra field fails its member's
      // strictness — there is no separate "is this a real operation"
      // check to forget.
      const parsed = BrokerRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new BrokerError('VALIDATION_FAILED', 'Unknown operation or malformed request body.');
      }

      const result = await handleOperation(parsed.data, {
        docker,
        dms: config.dms,
        panelServer: config.panelServer,
        panelBroker: config.panelBroker,
        visibleServicePatterns: config.visibleServicePatterns,
        logger,
      });

      // Validate the broker's own output before it ever leaves the
      // process, against the same schema RealBrokerClient validates on
      // receipt (@dwg/shared, one artifact). A malformed response here is
      // a broker bug — exactly the class of bug SECURITY.md §4.1 keeps
      // this service tiny to minimise — and this turns it into a loud
      // 500 rather than a silently-wrong payload trusted downstream.
      const responseSchema = BROKER_RESPONSE_SCHEMAS[parsed.data.operation];
      const validated: unknown = responseSchema.parse(result);
      void reply.send(validated);
    },
  );

  // M10 backups/restore (IMPLEMENTATION_PLAN.md §2.1) — two streaming
  // routes outside the JSON `/v1/ops` contract above; see
  // `archive-routes.ts`'s own header for why they cannot be operations in
  // that closed vocabulary.
  const operationDeps: OperationDeps = {
    docker,
    dms: config.dms,
    panelServer: config.panelServer,
    panelBroker: config.panelBroker,
    visibleServicePatterns: config.visibleServicePatterns,
    logger,
  };
  registerArchiveRoutes(app, { config, docker, deps: operationDeps });

  return app;
}
