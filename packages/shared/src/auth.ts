/**
 * Zod schemas for authentication, sessions, CSRF and administrator
 * management (M3 — ARCHITECTURE.md §7.3 data model, §7.4 sessions;
 * SECURITY.md §3.5 auth/session/brute-force, §3.6 CSRF, §3.9 privilege
 * escalation). Same artifact backs server-side validation and
 * client-side types (ARCHITECTURE.md §3) — a contract change here is a
 * compile error everywhere it's consumed.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * A single role for now. Modelled as an extensible enum plus a
 * server-side permission map (`apps/server/src/modules/auth/roles.ts`)
 * rather than scattered `role === 'administrator'` checks, so adding a
 * second role later is appending a literal here and an entry to that
 * map — never a change to the authorization *logic* that checks it.
 */
export const ADMIN_ROLES = ['administrator'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const AdminRoleSchema = z.enum(ADMIN_ROLES);

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

/**
 * Minimum password length for a *new* password (bootstrap, admin
 * creation, change-password). Deliberately a length floor with no
 * composition rules (no forced uppercase/digit/symbol) — current NIST SP
 * 800-63B / OWASP ASVS guidance favours length over composition, since
 * composition rules push users toward predictable substitutions
 * (`Passw0rd!`) without a real entropy gain.
 */
export const PASSWORD_MIN_LENGTH = 12;
/** Generous ceiling: bounds request size and Argon2 input cost, not a usability constraint. */
export const PASSWORD_MAX_LENGTH = 256;

/** Policy for a *new* password. Not used for login's `password` field — see {@link LoginRequestSchema}. */
export const NewPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * A password *submitted for verification* (login, or the `currentPassword`
 * leg of a change-password request) is only bounded, never held to the
 * current policy's minimum. A hash created under an older or different
 * policy must still be checkable, and — just as important — rejecting a
 * too-short login password at the schema layer would have to be exactly
 * as costly as a real login attempt or it becomes a timing tell that is
 * independent of, and in addition to, the one `verifyPassword`'s dummy
 * hash already defends against. Simplest correct answer: never special-case
 * length for a credential being *verified*, only for one being *set*.
 */
export const SubmittedPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

// ---------------------------------------------------------------------------
// Administrator DTOs
// ---------------------------------------------------------------------------

/** Public shape of an administrator. Never includes the password hash — enforced by simply never putting that field here. */
export const AdminSummarySchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: AdminRoleSchema,
  disabled: z.boolean(),
  forcePasswordChange: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminSummary = z.infer<typeof AdminSummarySchema>;

export const AdminListResponseSchema = z.object({
  admins: z.array(AdminSummarySchema),
});
export type AdminListResponse = z.infer<typeof AdminListResponseSchema>;

export const CreateAdminRequestSchema = z.object({
  email: z.string().email(),
  password: NewPasswordSchema,
});
export type CreateAdminRequest = z.infer<typeof CreateAdminRequestSchema>;

export const CreateAdminResponseSchema = z.object({
  admin: AdminSummarySchema,
});
export type CreateAdminResponse = z.infer<typeof CreateAdminResponseSchema>;

/**
 * Partial update. `role` accepts today's single value — kept in the
 * request shape (rather than omitted entirely) so a future second role
 * is a schema relaxation, not a new endpoint.
 */
export const UpdateAdminRequestSchema = z
  .object({
    disabled: z.boolean().optional(),
    role: AdminRoleSchema.optional(),
  })
  .refine((data) => data.disabled !== undefined || data.role !== undefined, {
    message: 'at least one of disabled or role must be provided',
  });
export type UpdateAdminRequest = z.infer<typeof UpdateAdminRequestSchema>;

export const UpdateAdminResponseSchema = z.object({
  admin: AdminSummarySchema,
});
export type UpdateAdminResponse = z.infer<typeof UpdateAdminResponseSchema>;

// ---------------------------------------------------------------------------
// Login / logout / session
// ---------------------------------------------------------------------------

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: SubmittedPasswordSchema,
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  admin: AdminSummarySchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const LogoutResponseSchema = z.object({
  loggedOut: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

/** `GET` current-session response. */
export const SessionInfoResponseSchema = z.object({
  admin: AdminSummarySchema,
  expiresAt: z.string(),
});
export type SessionInfoResponse = z.infer<typeof SessionInfoResponseSchema>;

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: SubmittedPasswordSchema,
    newPassword: NewPasswordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'newPassword must differ from currentPassword',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const ChangePasswordResponseSchema = z.object({
  admin: AdminSummarySchema,
});
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponseSchema>;

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/** Header the SPA echoes the CSRF token in on every state-changing request (SECURITY.md §3.6). */
export const CSRF_HEADER_NAME = 'x-csrf-token';

export const CsrfTokenResponseSchema = z.object({
  csrfToken: z.string(),
});
export type CsrfTokenResponse = z.infer<typeof CsrfTokenResponseSchema>;
