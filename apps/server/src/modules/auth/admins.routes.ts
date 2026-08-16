/**
 * Administrator CRUD under `/api/v1/admins` (M3 — ARCHITECTURE.md §7.1;
 * SECURITY.md §3.9 privilege escalation).
 *
 * Every route in this module sits behind `requireSession`, `requireCsrf`
 * and `requirePermission('admins:manage')` — applied once as scope-level
 * hooks below, not repeated per route, so "all of them" is true by
 * construction rather than by remembering to list three guards on every
 * new route. `admins:manage` is the only permission this milestone
 * defines, so today that is equivalent to "any enabled administrator,"
 * but the check is written against the permission, never the role
 * literal, so a narrower role added later changes only `roles.ts`.
 *
 * Two invariants are enforced here, not in `AdminsRepository` (a dumb
 * table-access layer with no notion of "the caller") or `AuthService`
 * (which has no notion of one admin acting on another):
 *
 *  - An administrator can never disable or delete their *own* account
 *    (lockout prevention).
 *  - The last *enabled* administrator can never be disabled or deleted,
 *    full stop.
 *
 * Both are checked from data read fresh inside the request — never from
 * anything the client asserted.
 */
import type { FastifyInstance } from 'fastify';
import {
  AdminListResponseSchema,
  CreateAdminRequestSchema,
  CreateAdminResponseSchema,
  UpdateAdminRequestSchema,
  UpdateAdminResponseSchema,
  type AdminListResponse,
  type CreateAdminResponse,
  type UpdateAdminResponse,
} from '@dwg/shared';
import { AppError } from '../../platform/errors.js';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import { AdminsRepository, type AdminRow, type UpdateAdminPatch } from './admins.repository.js';
import { toAdminSummary } from './auth.service.js';
import { hashPassword } from './password.js';
import { requireAuthContext, type AuthMiddleware } from './auth.middleware.js';
import { parseBody } from './auth.routes.js';

export interface AdminsRoutesDeps {
  readonly db: Database;
  readonly admins: AdminsRepository;
  readonly middleware: AuthMiddleware;
}

/** Blocks an admin from disabling or deleting their own account, whatever the current state of the rest of the table. */
export function assertNotSelf(
  actorId: string,
  targetId: string,
  action: 'disable' | 'delete',
): void {
  if (actorId === targetId) {
    throw new AppError('FORBIDDEN', `You cannot ${action} your own administrator account.`);
  }
}

/**
 * Blocks removing the system's last usable administrator. Scoped to
 * *enabled* administrators specifically: a disabled account is already
 * unusable, so it does not count toward "at least one remains," and
 * re-disabling one that is already disabled is a harmless no-op that
 * must not be blocked by this check.
 *
 * Exported (like {@link assertNotSelf}) so its boundary — exactly one
 * enabled administrator left, versus two, versus a disabled target — can
 * be pinned by a direct unit test. That matters here specifically because
 * the two route handlers below always call this *after* `assertNotSelf`,
 * and an actor must themselves be enabled to hold the session that got
 * them into the handler at all: whenever `countEnabled() <= 1` is actually
 * true, that lone enabled administrator can only be the actor, which
 * means `assertNotSelf` has, in every reachable case, already thrown
 * first. This function's own throw is consequently unreachable through
 * the HTTP routes today — it is kept anyway as the independently-correct
 * guard SECURITY.md §3.9 asks for, and as a backstop against a future
 * change (a second role, a batch/service path that bypasses the
 * self-check) reintroducing a reachable case. Do not delete it as
 * "dead code" without re-deriving this argument.
 */
export function assertNotLastEnabledAdmin(admins: AdminsRepository, target: AdminRow): void {
  if (target.disabled) {
    return;
  }
  if (admins.countEnabled() <= 1) {
    throw new AppError('CONFLICT', 'At least one enabled administrator must remain.');
  }
}

export async function registerAdminsRoutes(
  app: FastifyInstance,
  deps: AdminsRoutesDeps,
): Promise<void> {
  const { db, admins, middleware } = deps;
  const { requireSession, requireCsrf, requirePermission } = middleware;

  await app.register(
    async (adminsApp) => {
      adminsApp.addHook('preHandler', requireSession());
      adminsApp.addHook('preHandler', requireCsrf());
      adminsApp.addHook('preHandler', requirePermission('admins:manage'));

      adminsApp.get('/', async (_request, reply) => {
        const rows = admins.list();
        const response: AdminListResponse = { admins: rows.map(toAdminSummary) };
        void reply.send(AdminListResponseSchema.parse(response));
      });

      adminsApp.post('/', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(CreateAdminRequestSchema, request.body);

        if (admins.findByEmail(body.email) !== undefined) {
          throw new AppError('CONFLICT', 'An administrator with that email already exists.');
        }

        const passwordHash = await hashPassword(body.password);
        // A newly-created account starts with a password only the creator
        // knows, so — same posture as bootstrap, and for the same reason
        // (see PASSWORD_CHANGE_REQUIRED's doc comment in
        // packages/shared/src/errors.ts) — it forces a change on first
        // login.
        const created = admins.create({
          email: body.email,
          passwordHash,
          role: 'administrator',
          forcePasswordChange: true,
        });

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'admin.create',
          target: { type: 'admin', id: created.id },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { email: created.email },
        });

        reply.status(201);
        const response: CreateAdminResponse = { admin: toAdminSummary(created) };
        void reply.send(CreateAdminResponseSchema.parse(response));
      });

      adminsApp.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const auth = requireAuthContext(request);
        const body = parseBody(UpdateAdminRequestSchema, request.body);

        const target = admins.findById(request.params.id);
        if (target === undefined) {
          throw new AppError('NOT_FOUND', 'That administrator does not exist.');
        }

        if (body.disabled === true) {
          assertNotSelf(auth.admin.id, target.id, 'disable');
          assertNotLastEnabledAdmin(admins, target);
        }

        // exactOptionalPropertyTypes: only include a key when the request
        // actually supplied it, rather than assigning `undefined` into an
        // optional field the patch type declares as exactly `boolean`/
        // `AdminRole` when present.
        const patch: UpdateAdminPatch = {
          ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
        };
        admins.update(target.id, patch);
        const updated = admins.findById(target.id) ?? target;

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'admin.update',
          target: { type: 'admin', id: updated.id },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { disabled: updated.disabled, role: updated.role },
        });

        const response: UpdateAdminResponse = { admin: toAdminSummary(updated) };
        void reply.send(UpdateAdminResponseSchema.parse(response));
      });

      adminsApp.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const auth = requireAuthContext(request);
        const target = admins.findById(request.params.id);
        if (target === undefined) {
          throw new AppError('NOT_FOUND', 'That administrator does not exist.');
        }

        assertNotSelf(auth.admin.id, target.id, 'delete');
        assertNotLastEnabledAdmin(admins, target);

        // Sessions cascade via the sessions.admin_id FK (ON DELETE
        // CASCADE, migration 001) — nothing else to clean up here.
        admins.delete(target.id);

        recordAuditEvent(db, {
          actor: { adminId: auth.admin.id, label: auth.admin.email },
          action: 'admin.delete',
          target: { type: 'admin', id: target.id },
          result: 'success',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { email: target.email },
        });

        reply.status(204);
        void reply.send();
      });
    },
    { prefix: '/api/v1/admins' },
  );
}
