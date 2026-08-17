/**
 * `/api/v1/docker/images/*` (M9 — FEATURE_MATRIX.md §24). `prune` is the
 * only mutation and takes no body — there is no route (and no schema
 * anywhere beneath it) that removes one named image; see
 * `images.service.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { ImageListResponseSchema, ImagePruneResponseSchema } from '@dwg/shared';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { requireAuthContext, type AuthMiddleware } from '../auth/auth.middleware.js';
import type { ImagesService } from './images.service.js';

export interface ImagesRoutesDeps {
  readonly db: Database;
  readonly imagesService: ImagesService;
  readonly middleware: AuthMiddleware;
}

export async function registerImagesRoutes(
  app: FastifyInstance,
  deps: ImagesRoutesDeps,
): Promise<void> {
  const { db, imagesService, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (imagesApp) => {
      imagesApp.addHook('preHandler', requireSession());
      imagesApp.addHook('preHandler', requireCsrf());
      imagesApp.addHook('preHandler', requirePermission('docker:manage'));

      imagesApp.get('/', async (_request, reply) => {
        const images = await imagesService.list();
        void reply.send(ImageListResponseSchema.parse({ images }));
      });

      imagesApp.post('/prune', async (request, reply) => {
        const auth = requireAuthContext(request);
        const result = await imagesService.prune();

        // No single target: a prune sweep removes zero or more dangling
        // images at once, never one named resource — the actual effect is
        // recorded in `details` instead.
        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'image.prune',
          target: null,
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: {
            imagesDeletedCount: result.imagesDeleted.length,
            spaceReclaimedBytes: result.spaceReclaimedBytes,
          },
        });

        void reply.send(ImagePruneResponseSchema.parse(result));
      });
    },
    { prefix: '/api/v1/docker/images' },
  );
}
