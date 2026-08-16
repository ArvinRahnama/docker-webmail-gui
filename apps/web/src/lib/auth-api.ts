/**
 * Typed wrappers over `/api/v1/auth/*` (apps/server/src/modules/auth/auth.routes.ts).
 * Thin on purpose: each function is just a path, a method and the shared
 * Zod schema for that endpoint's response, so a route/schema change in
 * `@dwg/shared` is felt here at compile time.
 */
import {
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  SessionInfoResponseSchema,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type LoginRequest,
  type LoginResponse,
  type LogoutResponse,
  type SessionInfoResponse,
} from '@dwg/shared';
import { invalidateCsrfToken, request } from './api-client';

export async function login(credentials: LoginRequest): Promise<LoginResponse> {
  // Validate the outgoing body too — a malformed request is a programmer
  // error worth catching in dev rather than letting the server reject it.
  const body = LoginRequestSchema.parse(credentials);
  const result = await request('/api/v1/auth/login', LoginResponseSchema, { method: 'POST', body });
  // A fresh session means the CSRF token tied to the previous one (if any
  // — e.g. an anonymous pre-login token was never issued, but belt and
  // braces) is no longer valid.
  invalidateCsrfToken();
  return result;
}

export async function logout(): Promise<LogoutResponse> {
  const result = await request('/api/v1/auth/logout', LogoutResponseSchema, { method: 'POST' });
  invalidateCsrfToken();
  return result;
}

export async function fetchSession(): Promise<SessionInfoResponse> {
  return request('/api/v1/auth/session', SessionInfoResponseSchema, { method: 'GET' });
}

export async function changePassword(
  input: ChangePasswordRequest,
): Promise<ChangePasswordResponse> {
  const body = ChangePasswordRequestSchema.parse(input);
  return request('/api/v1/auth/change-password', ChangePasswordResponseSchema, {
    method: 'POST',
    body,
  });
}
