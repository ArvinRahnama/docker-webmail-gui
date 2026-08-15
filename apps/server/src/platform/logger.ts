/**
 * Structured logging (Pino — ARCHITECTURE.md §3) with a mandatory
 * redaction list (SECURITY.md §3.10 secret exposure, §3.11 log
 * injection).
 *
 * Redaction is enforced HERE, centrally, rather than relying on every
 * call site to remember to scrub a field before logging. A handler that
 * logs `logger.info({ admin })` or `logger.debug({ req })` must not be
 * able to leak a password or session token by omission — this module is
 * the single choke point that guarantees it, regardless of how deeply
 * the sensitive key is nested in whatever gets logged.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Keys whose values are never safe to log, however they're spelled in
 * whatever object happens to get logged. SECURITY.md §3.10 names this
 * exact list (plus header/body nesting, handled by
 * {@link buildRedactionPaths} below) as the mandatory minimum.
 */
export const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'sessionToken',
  'cookie',
  // The response-side counterpart of `cookie`: this is the header that
  // actually carries a session token to the browser (ARCHITECTURE.md
  // §7.4). Not in SECURITY.md §3.10's literal list, but squarely inside
  // its intent — anything that logs response headers must not leak one.
  'set-cookie',
  'setCookie',
  'authorization',
  'secret',
  'cookieSecret',
  'brokerSharedSecret',
  'rspamdPassword',
  'privateKey',
  'dkimKey',
] as const;

// A deliberate limitation, recorded so it reads as a decision rather than an
// oversight.
//
// Pino's redaction is CASE-SENSITIVE. Verified directly: given the path
// `authorization`, a key spelled `Authorization` passes through unredacted.
// The keys above are therefore lowercase, and we rely on every source of
// header-shaped objects in this application lowercasing header names — Node
// and Fastify do so for inbound request headers and for `reply.getHeaders()`,
// and undici does so for responses, per the fetch specification.
//
// Expanding every key into its case variants was considered and rejected: it
// multiplies the redaction path count to defend against a case the platform
// already prevents. The residual cost is that a *hand-built* log payload
// using a capitalised key would leak, so the rule is simply that log fields
// are spelled in lowercase. `logger.test.ts` pins both halves of this — that
// lowercase keys redact, and that the capitalised form does not — so the
// assumption cannot rot silently into a surprise.

/**
 * How many levels of object nesting to guard with a wildcard, in
 * addition to the bare top-level key. Depth 2 alone covers the two
 * shapes SECURITY.md calls out by name — `req.headers.<key>` and
 * `<anything>.body.<key>` are both exactly two levels deep — and we go
 * one level further as cheap defence-in-depth for DTOs logged as
 * `{ context: { user: { password } } }`-style nested objects.
 */
const MAX_WILDCARD_DEPTH = 3;

/**
 * Expands each sensitive key into fast-redact path patterns: the bare
 * key, plus `*.key`, `*.*.key`, … up to {@link MAX_WILDCARD_DEPTH}. Pino
 * (via fast-redact) does not support a recursive/any-depth wildcard, so
 * explicit depths are how "redact this key wherever it plausibly
 * appears" is expressed. A path that never matches anything in a given
 * log call is simply a no-op — fast-redact does not require every path
 * to exist on every object it processes.
 */
export function buildRedactionPaths(keys: readonly string[]): readonly string[] {
  const paths: string[] = [];
  for (const key of keys) {
    paths.push(key);
    let prefix = '';
    for (let depth = 1; depth <= MAX_WILDCARD_DEPTH; depth += 1) {
      prefix += depth === 1 ? '*' : '.*';
      paths.push(`${prefix}.${key}`);
    }
  }
  return paths;
}

export const REDACTION_PATHS: readonly string[] = Object.freeze(
  buildRedactionPaths(SENSITIVE_KEYS),
);

const REDACTION_CENSOR = '[REDACTED]';

export interface CreateLoggerOptions {
  readonly level: NonNullable<LoggerOptions['level']>;
  /** Defaults to `@dwg/server`. */
  readonly name?: string;
  /**
   * Write destination. Defaults to stdout (Pino's normal behaviour when
   * omitted). Tests pass an in-memory sink here to assert on output
   * without touching the real stdout stream.
   */
  readonly stream?: NodeJS.WritableStream | { write(chunk: string): void };
}

/** Builds the application's Pino logger. Every logger the process uses should come from here. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level,
    name: options.name ?? '@dwg/server',
    // SECURITY.md §3.11: user input is always a field value in structured
    // JSON, never spliced into a message string, so newline/CRLF forgery
    // cannot fabricate a log line. The redact list below is the control
    // for §3.10.
    redact: {
      paths: [...REDACTION_PATHS],
      censor: REDACTION_CENSOR,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return options.stream ? pino(pinoOptions, options.stream) : pino(pinoOptions);
}
