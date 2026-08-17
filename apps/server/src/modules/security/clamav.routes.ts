/**
 * `/api/v1/security/clamav/*` (FEATURE_MATRIX.md §16). Status/detections
 * are reads; `/update` triggers `freshclam` — a real operation FEATURE_MATRIX.md
 * calls out as needing "confirmation and rate limiting," so this whole
 * scope is rate-limited (mirroring `dkim.routes.ts`'s reasoning: status
 * reads drive a live socket/log read too) and `/update` is additionally
 * audited.
 */
import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import {
  ClamAvDetectionsResponseSchema,
  ClamAvStatusResponseSchema,
  ClamAvUpdateResponseSchema,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import type { ClamavService } from './clamav.service.js';

export interface ClamavRoutesDeps {
  readonly db: Database;
  readonly clamavService: ClamavService;
  readonly middleware: AuthMiddleware;
}

const CLAMAV_RATE_LIMIT_MAX = 30;
const CLAMAV_RATE_LIMIT_WINDOW = '1 minute';

export async function registerClamavRoutes(
  app: FastifyInstance,
  deps: ClamavRoutesDeps,
): Promise<void> {
  const { db, clamavService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (clamavApp) => {
      clamavApp.addHook('preHandler', requireSession());
      clamavApp.addHook('preHandler', requireCsrf());
      clamavApp.addHook('preHandler', requirePermission('security:manage'));

      await clamavApp.register(fastifyRateLimit, {
        max: CLAMAV_RATE_LIMIT_MAX,
        timeWindow: CLAMAV_RATE_LIMIT_WINDOW,
        errorResponseBuilder: () =>
          new AppError('RATE_LIMITED', 'Too many ClamAV requests. Try again in a minute.'),
      });

      clamavApp.get('/', async (_request, reply) => {
        const status = await clamavService.getStatus();
        void reply.send(ClamAvStatusResponseSchema.parse(status));
      });

      clamavApp.get('/detections', async (_request, reply) => {
        const detections = await clamavService.getDetections();
        void reply.send(ClamAvDetectionsResponseSchema.parse(detections));
      });

      clamavApp.post('/update', async (request, reply) => {
        const auth = requireAuthContext(request);
        const result = await clamavService.triggerSignatureUpdate();

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'clamav.signature_update',
          target: null,
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { outputLength: result.output.length },
        });

        void reply.send(ClamAvUpdateResponseSchema.parse(result));
      });
    },
    { prefix: '/api/v1/security/clamav' },
  );
}
