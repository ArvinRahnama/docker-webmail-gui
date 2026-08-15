import { describe, expect, it } from 'vitest';
import { ApiErrorEnvelopeSchema, HealthResponseSchema } from './api.js';

describe('ApiErrorEnvelopeSchema', () => {
  it('accepts a well-formed envelope matching ARCHITECTURE.md §7.1', () => {
    const result = ApiErrorEnvelopeSchema.safeParse({
      error: {
        code: 'NOT_FOUND',
        message: 'That mailbox does not exist.',
        errorId: 'e_01J9X4Q2M5K8QZC7X9J0T8N5AB',
        details: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts non-null, non-sensitive structured details', () => {
    const result = ApiErrorEnvelopeSchema.safeParse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Invalid input.',
        errorId: 'e_x',
        details: { fields: ['email'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('recursively validates nested objects/arrays within details', () => {
    const result = ApiErrorEnvelopeSchema.safeParse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Invalid input.',
        errorId: 'e_x',
        details: {
          issues: [{ field: 'email', reason: 'invalid', count: 2, fatal: false, extra: null }],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects details containing a non-JSON value (e.g. a function), even nested', () => {
    const result = ApiErrorEnvelopeSchema.safeParse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Invalid input.',
        errorId: 'e_x',
        details: { issues: [{ callback: () => {} }] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing details key', () => {
    const result = ApiErrorEnvelopeSchema.safeParse({
      error: { code: 'INTERNAL', message: 'x', errorId: 'e_x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown error code', () => {
    const result = ApiErrorEnvelopeSchema.safeParse({
      error: { code: 'TOTALLY_MADE_UP', message: 'x', errorId: 'e_x', details: null },
    });
    expect(result.success).toBe(false);
  });
});

describe('HealthResponseSchema', () => {
  it('accepts a valid health response', () => {
    expect(
      HealthResponseSchema.safeParse({ status: 'ok', version: '0.1.0', uptime: 12.5 }).success,
    ).toBe(true);
  });

  it('rejects a negative uptime', () => {
    expect(
      HealthResponseSchema.safeParse({ status: 'ok', version: '0.1.0', uptime: -1 }).success,
    ).toBe(false);
  });

  it('rejects a non-"ok" status', () => {
    expect(
      HealthResponseSchema.safeParse({ status: 'degraded', version: '0.1.0', uptime: 1 }).success,
    ).toBe(false);
  });
});
