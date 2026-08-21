/**
 * `GET`/`PUT /v1/archive/:volumeKey` — the two streaming routes M10
 * backups/restore are built on (`apps/server/src/modules/backups/`).
 * Deliberately **not** part of `/v1/ops`'s JSON request/response contract
 * (`operations.ts`, `@dwg/shared`'s `broker.ts`): a Docker volume can be
 * many gigabytes, and that endpoint validates one small JSON body against
 * a 64KB limit and returns one small JSON body in reply. These two routes
 * instead pass a `tar` stream straight through — Docker's own
 * `GET`/`PUT .../archive` bodies, byte for byte, in both directions —
 * using the *same* shared-secret guard (`createSecretGuard`) and the same
 * closed, broker-owned key→path mapping style as `LOG_FILE_PATHS`
 * (`operations.ts`) and `CONSOLE_COMMAND_ARGV` before it.
 *
 * `:volumeKey` is one of `@dwg/shared`'s four {@link BackupVolumeKey}
 * symbolic keys — never a path. `ARCHIVE_VOLUME_PATHS` below is the one
 * place that maps a key to the real absolute container path, and it is
 * asserted (by `backups.test.ts`, `@dwg/shared`) to agree with
 * `BACKUP_VOLUME_CONTAINER_PATHS`, the display/manifest-only copy the web
 * tier sees — so a client can select *which* fixed volume, never *where*,
 * exactly like `logs.file`.
 */
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import {
  BACKUP_VOLUME_CONTAINER_PATHS,
  BackupVolumeKeySchema,
  type BackupVolumeKey,
} from '@dwg/shared';
import type { BrokerConfig } from './config.js';
import type { DockerApi } from './docker-types.js';
import { createSecretGuard } from './auth.js';
import { BrokerError } from './errors.js';
import { resolveOrForbid, type OperationDeps } from './operations.js';

export interface ArchiveRoutesOptions {
  readonly config: BrokerConfig;
  readonly docker: DockerApi;
  readonly deps: OperationDeps;
}

/** Same key→path mapping `@dwg/shared`'s `BACKUP_VOLUME_CONTAINER_PATHS` documents — duplicated here (not imported as the sole source) because *this* copy is the one actually used to reach Docker; `backups.test.ts` pins the two identical. */
const ARCHIVE_VOLUME_PATHS: Readonly<Record<BackupVolumeKey, string>> =
  BACKUP_VOLUME_CONTAINER_PATHS;

/**
 * Mail volumes can be many gigabytes; `/v1/ops`'s 64KB `bodyLimit`
 * (`app.ts`) exists precisely because *that* route's bodies are always a
 * handful of small fields, which does not hold here. Generous rather than
 * unbounded: still a real ceiling (100 GiB) so a runaway or malicious
 * sender cannot exhaust the broker's disk/memory indefinitely, but high
 * enough not to be a realistic limit for any DMS deployment this project
 * targets.
 */
const ARCHIVE_BODY_LIMIT_BYTES = 100 * 1024 * 1024 * 1024;

const ARCHIVE_CONTENT_TYPE = 'application/x-tar';

function parseVolumeKey(raw: string): BackupVolumeKey {
  const parsed = BackupVolumeKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new BrokerError('VALIDATION_FAILED', `Unknown volume key: ${raw}`);
  }
  return parsed.data;
}

export function registerArchiveRoutes(app: FastifyInstance, options: ArchiveRoutesOptions): void {
  const { config, docker, deps } = options;

  void app.register(
    async (archiveApp) => {
      // Passes the raw request stream straight through as `request.body`
      // rather than buffering/parsing it — the one property this whole
      // file exists to preserve (see the module header: no re-serialising
      // means uid/gid/mode/mtime, including vmail's 5000:5000, survive
      // restore untouched).
      archiveApp.addContentTypeParser(ARCHIVE_CONTENT_TYPE, (_request, payload, done) => {
        done(null, payload);
      });

      archiveApp.get<{ Params: { volumeKey: string } }>(
        '/:volumeKey',
        { onRequest: [createSecretGuard(config.sharedSecret)] },
        async (request, reply) => {
          const volumeKey = parseVolumeKey(request.params.volumeKey);
          const ref = await resolveOrForbid(deps);
          const path = ARCHIVE_VOLUME_PATHS[volumeKey];

          let tarStream: NodeJS.ReadableStream;
          try {
            tarStream = await docker.getContainerArchive(ref.id, path);
          } catch (err) {
            deps.logger.error({ err, volumeKey, path }, 'archive.get: Docker call failed');
            throw new BrokerError('UPSTREAM_UNAVAILABLE', 'Could not read the requested volume.');
          }

          // Piped directly onto the raw response via `reply.hijack()` —
          // the same technique `platform/sse.ts` uses for its own
          // non-JSON response — rather than Fastify's own `reply.send()`,
          // whose stream auto-detection this route does not rely on. This
          // is the most direct way to guarantee the tar bytes reach the
          // client exactly as Docker produced them.
          reply.hijack();
          reply.raw.writeHead(200, { 'content-type': ARCHIVE_CONTENT_TYPE });
          tarStream.on('error', (err) => {
            deps.logger.error({ err, volumeKey, path }, 'archive.get: stream error while sending');
            reply.raw.destroy();
          });
          tarStream.pipe(reply.raw);
        },
      );

      archiveApp.put<{ Params: { volumeKey: string }; Body: IncomingMessage }>(
        '/:volumeKey',
        {
          onRequest: [createSecretGuard(config.sharedSecret)],
          bodyLimit: ARCHIVE_BODY_LIMIT_BYTES,
        },
        async (request, reply) => {
          const volumeKey = parseVolumeKey(request.params.volumeKey);
          const ref = await resolveOrForbid(deps);
          const path = ARCHIVE_VOLUME_PATHS[volumeKey];

          try {
            await docker.putContainerArchive(ref.id, path, request.body);
          } catch (err) {
            deps.logger.error({ err, volumeKey, path }, 'archive.put: Docker call failed');
            throw new BrokerError('UPSTREAM_UNAVAILABLE', 'Could not write the requested volume.');
          }

          void reply.code(204).send();
        },
      );
    },
    { prefix: '/v1/archive' },
  );
}
