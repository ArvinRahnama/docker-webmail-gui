/**
 * `/api/v1/jobs/*` (M10 — ARCHITECTURE.md §7.5, §8). Generic list/detail/
 * cancel plus one SSE stream per job. Every route here is gated on
 * `maintenance:manage` — the same permission every other M10 module uses,
 * mirroring `docker:manage`'s grouping of the M9 modules.
 */
import type { FastifyInstance } from 'fastify';
import { JobDetailResponseSchema, JobListResponseSchema, type JobStreamEvent } from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { beginSseStream } from '../../platform/sse.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import type { JobsService } from './jobs.service.js';

export interface JobsRoutesDeps {
  readonly db: Database;
  readonly jobsService: JobsService;
  readonly middleware: AuthMiddleware;
}

export async function registerJobsRoutes(
  app: FastifyInstance,
  deps: JobsRoutesDeps,
): Promise<void> {
  const { db, jobsService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (jobsApp) => {
      jobsApp.addHook('preHandler', requireSession());
      jobsApp.addHook('preHandler', requireCsrf());
      jobsApp.addHook('preHandler', requirePermission('maintenance:manage'));

      jobsApp.get('/', async (_request, reply) => {
        void reply.send(JobListResponseSchema.parse({ jobs: jobsService.list() }));
      });

      jobsApp.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const detail = jobsService.getDetail(request.params.id);
        void reply.send(JobDetailResponseSchema.parse(detail));
      });

      // Validated (job exists) *before* `beginSseStream` hijacks the
      // response — a 404 after hijacking would have nowhere normal to go,
      // since the uniform error envelope is a JSON response, not an SSE
      // frame.
      jobsApp.get<{ Params: { id: string } }>('/:id/stream', async (request, reply) => {
        const detail = jobsService.getDetail(request.params.id);
        const stream = beginSseStream(request, reply);
        stream.send('message', { kind: 'snapshot', job: detail.job } satisfies JobStreamEvent);

        const unsubscribe = jobsService.subscribe(request.params.id, (event) => {
          stream.send('message', event);
        });
        request.raw.on('close', unsubscribe);
      });

      jobsApp.post<{ Params: { id: string } }>('/:id/cancel', async (request, reply) => {
        const auth = requireAuthContext(request);
        const cancelled = jobsService.cancel(request.params.id);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'job.cancel',
          target: { type: 'job', id: cancelled.id },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        void reply.send(JobDetailResponseSchema.parse(jobsService.getDetail(cancelled.id)));
      });
    },
    { prefix: '/api/v1/jobs' },
  );
}
