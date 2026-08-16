/**
 * Authorization: role -> permission mapping (SECURITY.md §3.9). A
 * single `administrator` role exists today (`@dwg/shared`'s
 * `AdminRoleSchema`), but every guard checks a *permission*, never a
 * role literal — so adding a second role later is a new
 * `AdminRoleSchema` value plus an entry in {@link ROLE_PERMISSIONS}
 * below, never a change to `requirePermission` or to any route that
 * calls it.
 */
import type { AdminRole } from '@dwg/shared';

export const PERMISSIONS = ['admins:manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<AdminRole, ReadonlySet<Permission>>> = {
  administrator: new Set(PERMISSIONS),
};

export function roleHasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
