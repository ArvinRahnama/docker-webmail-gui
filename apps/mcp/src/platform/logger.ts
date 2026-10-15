/**
 * Pino logger with a mandatory redaction list (same mechanism and
 * lower-case-key rule as apps/server/src/platform/logger.ts — see
 * SECURITY.md §3.10). apps/mcp handles more secret *kinds* than the admin
 * tier — setup passwords, mailbox passwords, OAuth codes, verifiers, access
 * and refresh tokens, client secrets, the vault key — so the list is longer.
 *
 * Two further rules, enforced here rather than by convention:
 *  - Request URLs are logged **without their query string** (an OAuth
 *    request's query carries `state`, `code_challenge` and similar values
 *    that have no business in a log, even when they are not secrets).
 *  - Request and response *bodies* are never logged: Fastify's default
 *    serializers do not log them, and no call site in apps/mcp passes a body,
 *    an email message or a tool argument object to the logger.
 *    `logger.security.test.ts` drives real flows and greps the raw output.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

export const MCP_SENSITIVE_KEYS = [
  'password',
  'setuppassword',
  'setupPassword',
  'mailboxpassword',
  'mailboxPassword',
  'pass',
  'secret',
  'controlsecret',
  'controlSecret',
  'client_secret',
  'clientsecret',
  'vaultkey',
  'vaultKey',
  'token',
  'access_token',
  'refresh_token',
  'accesstoken',
  'accessToken',
  'refreshtoken',
  'refreshToken',
  'code',
  'code_verifier',
  'authorization',
  'cookie',
  'set-cookie',
  'x-dwg-mcp-control-secret',
  'auth',
  'text',
  'html',
  'body',
  'content',
  'contentBase64',
  'attachments',
] as const;

const MAX_WILDCARD_DEPTH = 3;

export function buildRedactionPaths(keys: readonly string[]): string[] {
  const paths: string[] = [];
  for (const key of keys) {
    const safe = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
    paths.push(safe);
    let prefix = '';
    for (let depth = 1; depth <= MAX_WILDCARD_DEPTH; depth += 1) {
      prefix += depth === 1 ? '*' : '.*';
      paths.push(safe.startsWith('[') ? `${prefix}${safe}` : `${prefix}.${safe}`);
    }
  }
  return paths;
}

function stripQuery(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export interface CreateMcpLoggerOptions {
  readonly level: NonNullable<LoggerOptions['level']>;
  readonly stream?: NodeJS.WritableStream | { write(chunk: string): void };
}

export function createMcpLogger(options: CreateMcpLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level,
    name: '@dwg/mcp',
    redact: { paths: buildRedactionPaths(MCP_SENSITIVE_KEYS), censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      req: (req: { method?: string; url?: string; id?: string; ip?: string }) => ({
        id: req.id,
        method: req.method,
        url: stripQuery(req.url),
        ip: req.ip,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: pino.stdSerializers.err,
    },
  };
  return options.stream ? pino(pinoOptions, options.stream) : pino(pinoOptions);
}
