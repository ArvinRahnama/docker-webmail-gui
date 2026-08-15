import { describe, expect, it } from 'vitest';
import { createLogger, SENSITIVE_KEYS } from './logger.js';

/** Builds a logger that writes into an in-memory array instead of stdout, so tests can assert on the exact output. */
function createCapturingLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  });
  return { logger, lines };
}

describe('createLogger redaction', () => {
  it('redacts every SENSITIVE_KEYS entry at the top level, leaving the censor marker in its place', () => {
    const { logger, lines } = createCapturingLogger();
    const secretValues = Object.fromEntries(
      SENSITIVE_KEYS.map((key, index) => [key, `secret-value-${index}`]),
    );

    logger.info(secretValues, 'top level secrets');

    const line = lines[0]!;
    for (const value of Object.values(secretValues)) {
      expect(line).not.toContain(value);
    }
    expect(line).toContain('[REDACTED]');
  });

  it('redacts a sensitive key nested under req.headers, without over-redacting neighbouring fields', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info(
      { req: { headers: { authorization: 'Bearer top-secret-token', host: 'example.com' } } },
      'req log',
    );

    const line = lines[0]!;
    expect(line).not.toContain('top-secret-token');
    expect(line).toContain('example.com');
  });

  it('redacts a sensitive key nested under *.body, without over-redacting neighbouring fields', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info(
      { req: { body: { password: 'hunter2', email: 'admin@example.com' } } },
      'req body log',
    );

    const line = lines[0]!;
    expect(line).not.toContain('hunter2');
    expect(line).toContain('admin@example.com');
  });

  it('redacts set-cookie, the response header that actually carries a session token', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info({ res: { headers: { 'set-cookie': 'session=abc123; HttpOnly' } } }, 'res headers');

    expect(lines[0]).not.toContain('abc123');
  });

  it('redacts a secret nested more deeply than the two named shapes (defence in depth)', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info({ a: { b: { token: 'deep-secret-token' } } }, 'deep nested token');

    expect(lines[0]).not.toContain('deep-secret-token');
  });

  // These two pin a documented limitation rather than asserting an ideal.
  // Pino's redaction is case-sensitive, and we deliberately keep
  // SENSITIVE_KEYS lowercase instead of expanding every key into case
  // variants — see the comment beside SENSITIVE_KEYS in logger.ts. That is
  // only safe because Node, Fastify and undici all lowercase header names.
  // The second test therefore asserts the *leak*, on purpose: if a future
  // pino release made redaction case-insensitive, or someone added case
  // variants, it would fail and force a conscious update of the comment
  // rather than leaving a stale rationale behind.
  it('redacts a header-shaped key spelled the way the platform actually produces it (lowercase)', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info({ req: { headers: { authorization: 'Bearer platform-cased' } } }, 'lowercase');

    expect(lines[0]).not.toContain('platform-cased');
  });

  it('does NOT redact a capitalised variant — the documented, accepted limitation', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info(
      { req: { headers: { Authorization: 'Bearer hand-built-payload' } } },
      'capitalised',
    );

    // Asserting the current behaviour, not endorsing it. Log fields must be
    // spelled in lowercase; the platform guarantees this for real headers.
    expect(lines[0]).toContain('hand-built-payload');
  });

  it('does not throw when the logged object has none of the sensitive fields', () => {
    const { logger } = createCapturingLogger();

    expect(() =>
      logger.info({ hello: 'world', nested: { a: 1, b: { c: 2 } } }, 'plain log'),
    ).not.toThrow();
  });

  it('does not throw when logging a plain Error object', () => {
    const { logger } = createCapturingLogger();

    expect(() => logger.info({ err: new Error('boom') }, 'error log')).not.toThrow();
  });
});
