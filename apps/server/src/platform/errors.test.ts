import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { AppError, createErrorHandler, generateErrorId, generateId } from './errors.js';
import { createLogger, type CreateLoggerOptions } from './logger.js';

function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const stream: NonNullable<CreateLoggerOptions['stream']> = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const logger = createLogger({ level: 'info', stream });
  return { logger, lines };
}

function buildTestApp(logger: ReturnType<typeof createLogger>) {
  const app = Fastify();
  app.setErrorHandler(createErrorHandler(logger));
  return app;
}

describe('generateId / generateErrorId', () => {
  it('produces a "<prefix>_" + 26-character Crockford Base32 ULID-style ID', () => {
    expect(generateErrorId()).toMatch(/^e_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(generateId('req')).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is unique across many calls (collision-resistant)', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateErrorId()));
    expect(ids.size).toBe(2000);
  });

  it('sorts lexicographically in generation order (sortable)', () => {
    const a = generateId('e', 1_000_000);
    const b = generateId('e', 1_000_001);
    expect(a < b).toBe(true);
  });
});

describe('createErrorHandler — AppError', () => {
  it('maps an AppError to the §7.1 envelope using its own status, code, message and details', async () => {
    const { logger } = captureLogger();
    const app = buildTestApp(logger);
    app.get('/thing', () => {
      throw new AppError('NOT_FOUND', 'That mailbox does not exist.', {
        details: { field: 'mailbox' },
      });
    });

    const response = await app.inject({ method: 'GET', url: '/thing' });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'That mailbox does not exist.',
        errorId: expect.any(String),
        details: { field: 'mailbox' },
      },
    });
    await app.close();
  });

  it('defaults details to null when none is given', async () => {
    const { logger } = captureLogger();
    const app = buildTestApp(logger);
    app.get('/thing', () => {
      throw new AppError('CONFLICT', 'Already exists.');
    });

    const response = await app.inject({ method: 'GET', url: '/thing' });
    expect(response.json().error.details).toBeNull();
    await app.close();
  });
});

describe('createErrorHandler — unknown errors', () => {
  const secretInternalDetail = 'connection string: postgres://internal-only-detail:5432/db';

  it('maps an unknown error to a generic INTERNAL response with no internal message or stack leaked', async () => {
    const { logger } = captureLogger();
    const app = buildTestApp(logger);
    app.get('/boom', () => {
      throw new Error(secretInternalDetail);
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    const rawBody = response.body;
    const body = response.json();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).not.toContain(secretInternalDetail);
    expect(rawBody).not.toContain(secretInternalDetail);
    expect(rawBody).not.toContain('.ts:'); // no stack-trace-shaped file:line content
    expect(rawBody.toLowerCase()).not.toContain('at object.'); // no stack frame text
    await app.close();
  });

  it('returns the same generic message for every unknown error, regardless of what the real error says', async () => {
    const { logger } = captureLogger();
    const app = buildTestApp(logger);
    app.get('/boom-a', () => {
      throw new Error('first distinct internal detail');
    });
    app.get('/boom-b', () => {
      throw new TypeError('second distinct internal detail');
    });

    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: '/boom-a' }),
      app.inject({ method: 'GET', url: '/boom-b' }),
    ]);

    expect(a.json().error.message).toBe(b.json().error.message);
    expect(a.json().error.code).toBe('INTERNAL');
    expect(b.json().error.code).toBe('INTERNAL');
    await app.close();
  });

  it('logs the full error server-side under the same errorId returned to the client', async () => {
    const { logger, lines } = captureLogger();
    const app = buildTestApp(logger);
    app.get('/boom', () => {
      throw new Error('this detail must reach the server log, never the client');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });
    const errorId: string = response.json().error.errorId;

    expect(errorId.length).toBeGreaterThan(0);
    const matchingLogLine = lines.find((line) => line.includes(errorId));
    expect(matchingLogLine).toBeDefined();
    expect(matchingLogLine).toContain('this detail must reach the server log, never the client');
  });

  it('also correlates errorId for AppErrors between the client response and the server log', async () => {
    const { logger, lines } = captureLogger();
    const app = buildTestApp(logger);
    app.get('/thing', () => {
      throw new AppError('FORBIDDEN', 'Not permitted.');
    });

    const response = await app.inject({ method: 'GET', url: '/thing' });
    const errorId: string = response.json().error.errorId;

    expect(lines.some((line) => line.includes(errorId))).toBe(true);
  });
});

describe('createErrorHandler — framework-level errors', () => {
  it('maps a Fastify body-parse error (malformed JSON) to our envelope without leaking the raw parser message', async () => {
    const { logger } = captureLogger();
    const app = buildTestApp(logger);
    app.post('/thing', (request) => {
      return { received: request.body };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/thing',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not valid json',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(typeof body.error.errorId).toBe('string');
    // Fastify's raw parser error text (e.g. mentioning "JSON" position details) must not reach the client verbatim.
    expect(response.body).not.toMatch(/Unexpected token/);
    await app.close();
  });
});
