import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLES,
  AdminRoleSchema,
  ChangePasswordRequestSchema,
  CreateAdminRequestSchema,
  LoginRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  UpdateAdminRequestSchema,
} from './auth.js';

describe('AdminRoleSchema', () => {
  it('accepts every declared role and rejects anything else', () => {
    for (const role of ADMIN_ROLES) {
      expect(AdminRoleSchema.safeParse(role).success).toBe(true);
    }
    expect(AdminRoleSchema.safeParse('superadmin').success).toBe(false);
  });
});

describe('CreateAdminRequestSchema — password policy', () => {
  it('rejects a password shorter than the minimum', () => {
    const result = CreateAdminRequestSchema.safeParse({
      email: 'new-admin@example.com',
      password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a password exactly at the minimum', () => {
    const result = CreateAdminRequestSchema.safeParse({
      email: 'new-admin@example.com',
      password: 'a'.repeat(PASSWORD_MIN_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a password longer than the maximum', () => {
    const result = CreateAdminRequestSchema.safeParse({
      email: 'new-admin@example.com',
      password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed email', () => {
    const result = CreateAdminRequestSchema.safeParse({
      email: 'not-an-email',
      password: 'a'.repeat(PASSWORD_MIN_LENGTH),
    });
    expect(result.success).toBe(false);
  });
});

describe('LoginRequestSchema', () => {
  it('does not enforce the new-password minimum on the submitted login password', () => {
    // A short password must still be *parseable* here: whether it's wrong
    // is for the auth service to decide (uniformly, timing-safe), never
    // the request schema — see SubmittedPasswordSchema's comment.
    const result = LoginRequestSchema.safeParse({
      email: 'admin@example.com',
      password: 'short',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty password', () => {
    const result = LoginRequestSchema.safeParse({ email: 'admin@example.com', password: '' });
    expect(result.success).toBe(false);
  });
});

describe('ChangePasswordRequestSchema', () => {
  it('rejects when newPassword equals currentPassword', () => {
    const same = 'a-perfectly-fine-password-123';
    const result = ChangePasswordRequestSchema.safeParse({
      currentPassword: same,
      newPassword: same,
    });
    expect(result.success).toBe(false);
  });

  it('accepts distinct, policy-conformant passwords', () => {
    const result = ChangePasswordRequestSchema.safeParse({
      currentPassword: 'the-old-password-value',
      newPassword: 'a-brand-new-password-value',
    });
    expect(result.success).toBe(true);
  });
});

describe('UpdateAdminRequestSchema', () => {
  it('rejects an empty patch', () => {
    expect(UpdateAdminRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a disabled-only patch', () => {
    expect(UpdateAdminRequestSchema.safeParse({ disabled: true }).success).toBe(true);
  });

  it('accepts a role-only patch', () => {
    expect(UpdateAdminRequestSchema.safeParse({ role: 'administrator' }).success).toBe(true);
  });
});
