/**
 * MCP integration configuration, read by the panel's server process when
 * `MCP_ENABLED=true` (the MCP service runs inside the server container — see
 * docs/mcp-integration.md). Same two rules as
 * apps/server/src/platform/config.ts: every problem is reported at once, and
 * no error message ever echoes a secret's value.
 *
 * The vault key can be supplied inline (`MCP_VAULT_KEY`) or — preferred, and
 * what docker/compose.yaml uses — as a path to a mounted secret file
 * (`MCP_VAULT_KEY_FILE`). Setting both is rejected as ambiguous. In
 * production it is mandatory: the service refuses to start rather than run
 * with an ephemeral key that would silently make every stored credential
 * undecryptable after a restart.
 *
 * The control API is never exposed on a socket: the panel reaches it
 * in-process. It still authenticates every call, with a secret generated
 * fresh for each process (`controlSecret`), so nothing outside the process
 * can reach it even by accident.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { APP_VERSION } from '@dwg/shared';

export const MCP_APP_MODES = ['development', 'production'] as const;
export type McpAppMode = (typeof MCP_APP_MODES)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type McpLogLevel = (typeof LOG_LEVELS)[number];

/** Every variable apps/mcp reads — `.env.example` is held to this list by apps/server's config-env-example test. */
export const MCP_CONFIG_ENV_KEYS = [
  'APP_MODE',
  'LOG_LEVEL',
  'MCP_PUBLIC_HOST',
  'MCP_PUBLIC_PORT',
  'MCP_DATA_DIR',
  'MCP_PUBLIC_URL',
  'MCP_VAULT_KEY',
  'MCP_VAULT_KEY_FILE',
  'MCP_MAIL_BACKEND',
  'MCP_MAIL_HOST',
  'MCP_MAIL_TLS_CA_FILE',
  'MCP_TRUST_PROXY',
  'MCP_REQUIRE_HTTPS',
] as const;

function booleanVar(defaultValue: boolean | null) {
  return z
    .string()
    .optional()
    .transform((raw) => raw?.trim().toLowerCase())
    .refine((v) => v === undefined || v === '' || ['true', 'false', '1', '0'].includes(v), {
      message: 'must be "true" or "false"',
    })
    .transform((v) => (v === undefined || v === '' ? defaultValue : v === 'true' || v === '1'));
}

function portVar(defaultValue: number) {
  return z.preprocess(
    (raw) => (raw === undefined || raw === '' ? defaultValue : Number(raw)),
    z
      .number({ error: 'must be a number' })
      .int('must be a whole number')
      .min(1, 'must be between 1 and 65535')
      .max(65535, 'must be between 1 and 65535'),
  );
}

function stringVar(defaultValue: string) {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? defaultValue : raw.trim()));
}

function optionalStringVar() {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? null : raw.trim()));
}

const rawSchema = z.object({
  APP_MODE: z
    .string()
    .optional()
    .transform((raw) => raw?.trim())
    .refine((raw) => raw === undefined || (MCP_APP_MODES as readonly string[]).includes(raw), {
      message: `must be one of: ${MCP_APP_MODES.join(', ')}`,
    })
    .transform((raw) => (raw === undefined ? 'development' : (raw as McpAppMode))),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((raw) => raw?.trim())
    .refine((raw) => raw === undefined || (LOG_LEVELS as readonly string[]).includes(raw), {
      message: `must be one of: ${LOG_LEVELS.join(', ')}`,
    })
    .transform((raw) => (raw === undefined ? 'info' : (raw as McpLogLevel))),
  MCP_PUBLIC_HOST: stringVar('127.0.0.1'),
  MCP_PUBLIC_PORT: portVar(3100),
  MCP_DATA_DIR: optionalStringVar(),
  MCP_PUBLIC_URL: optionalStringVar().refine(
    (value) => value === null || isValidBaseUrl(value),
    'must be an absolute http(s) URL with no path, query or fragment, e.g. https://mcp.example.com',
  ),
  MCP_VAULT_KEY: optionalStringVar(),
  MCP_VAULT_KEY_FILE: optionalStringVar(),
  MCP_MAIL_BACKEND: z
    .string()
    .optional()
    .transform((raw) => raw?.trim().toLowerCase())
    .refine((raw) => raw === undefined || raw === '' || raw === 'imap' || raw === 'fake', {
      message: 'must be "imap" or "fake"',
    })
    .transform((raw) => (raw === 'fake' ? 'fake' : raw === 'imap' ? 'imap' : null)),
  MCP_MAIL_HOST: stringVar('mailserver'),
  MCP_MAIL_TLS_CA_FILE: optionalStringVar(),
  MCP_TRUST_PROXY: stringVar('loopback,linklocal,uniquelocal'),
  MCP_REQUIRE_HTTPS: booleanVar(null),
});

export function isValidBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.pathname === '/' &&
    !value.endsWith('/') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  );
}

export interface McpConfig {
  readonly appMode: McpAppMode;
  readonly isProduction: boolean;
  readonly logLevel: McpLogLevel;
  readonly publicListener: { readonly host: string; readonly port: number };
  readonly dataDir: string;
  /** Seed value for the `publicBaseUrl` setting on first boot; the setting (DB) wins afterwards. */
  readonly publicUrlSeed: string | null;
  /** Authenticates in-process control calls; random per process, never configured or persisted. */
  readonly controlSecret: string;
  /** 32-byte AES-256-GCM key, or `null` when none was configured (development only). */
  readonly vaultKey: Buffer | null;
  readonly mailBackend: 'imap' | 'fake';
  readonly mailHostSeed: string;
  /** Extra PEM CA bundle trusted for IMAP/SMTP TLS (self-signed docker-mailserver certificates). */
  readonly mailTlsCa: string | null;
  readonly trustProxy: string;
  readonly requireHttps: boolean;
  readonly version: string;
  readonly warnings: readonly string[];
}

export class McpConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      [
        'Invalid MCP integration configuration — fix the following and restart:',
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'),
    );
    this.name = 'McpConfigError';
    this.problems = problems;
  }
}

/** Reads a secret from inline env or a file, never both. Never puts the value in a message. */
function resolveSecret(
  name: string,
  inline: string | null,
  file: string | null,
  problems: string[],
  readFile: (path: string) => string,
): string | null {
  if (inline !== null && file !== null) {
    problems.push(`${name} and ${name}_FILE are both set; set only one.`);
    return null;
  }
  if (file !== null) {
    try {
      const value = readFile(file).trim();
      if (value.length === 0) {
        problems.push(`${name}_FILE points to an empty file.`);
        return null;
      }
      return value;
    } catch {
      problems.push(`${name}_FILE could not be read (check the path and file permissions).`);
      return null;
    }
  }
  return inline;
}

/** Accepts 64 hex characters or standard/url-safe base64 that decodes to exactly 32 bytes. */
export function parseVaultKey(value: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return decoded.length === 32 ? decoded : null;
  }
  return null;
}

export interface LoadMcpConfigOptions {
  readonly readFile?: (path: string) => string;
  readonly version?: string;
  /** Where the MCP database lives when MCP_DATA_DIR is unset (the server passes `${DATA_DIR}/mcp`). */
  readonly defaultDataDir?: string;
}

export function loadMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadMcpConfigOptions = {},
): McpConfig {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    throw new McpConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const data = parsed.data;
  const problems: string[] = [];
  const warnings: string[] = [];
  const isProduction = data.APP_MODE === 'production';

  const vaultKeyRaw = resolveSecret(
    'MCP_VAULT_KEY',
    data.MCP_VAULT_KEY,
    data.MCP_VAULT_KEY_FILE,
    problems,
    readFile,
  );
  let vaultKey: Buffer | null = null;
  if (vaultKeyRaw !== null) {
    vaultKey = parseVaultKey(vaultKeyRaw);
    if (vaultKey === null) {
      problems.push(
        'MCP_VAULT_KEY must be 32 bytes, as 64 hex characters or base64. Generate one with: openssl rand -hex 32',
      );
    }
  } else if (isProduction) {
    problems.push(
      'MCP_VAULT_KEY_FILE (or MCP_VAULT_KEY) is required in production — it encrypts stored mailbox credentials. installer/install.sh generates one.',
    );
  } else {
    warnings.push(
      'No vault key configured: mailbox credentials cannot be stored in this development process.',
    );
  }

  const mailBackend = data.MCP_MAIL_BACKEND ?? (isProduction ? 'imap' : 'fake');
  if (isProduction && mailBackend === 'fake') {
    problems.push(
      'MCP_MAIL_BACKEND=fake is a development-only test double and is refused in production.',
    );
  }

  let mailTlsCa: string | null = null;
  if (data.MCP_MAIL_TLS_CA_FILE !== null) {
    try {
      mailTlsCa = readFile(data.MCP_MAIL_TLS_CA_FILE);
    } catch {
      problems.push('MCP_MAIL_TLS_CA_FILE could not be read.');
    }
  }

  if (problems.length > 0) throw new McpConfigError(problems);

  if (data.MCP_PUBLIC_URL !== null && data.MCP_PUBLIC_URL.startsWith('http:') && isProduction) {
    warnings.push(
      'MCP_PUBLIC_URL is http://. OAuth and MCP endpoints must be served over HTTPS; the service will refuse to issue tokens until it is https://.',
    );
  }

  return Object.freeze({
    appMode: data.APP_MODE,
    isProduction,
    logLevel: data.LOG_LEVEL,
    publicListener: Object.freeze({ host: data.MCP_PUBLIC_HOST, port: data.MCP_PUBLIC_PORT }),
    dataDir: data.MCP_DATA_DIR ?? options.defaultDataDir ?? './data/mcp',
    publicUrlSeed: data.MCP_PUBLIC_URL,
    controlSecret: randomBytes(32).toString('hex'),
    vaultKey,
    mailBackend,
    mailHostSeed: data.MCP_MAIL_HOST,
    mailTlsCa,
    trustProxy: data.MCP_TRUST_PROXY,
    requireHttps: data.MCP_REQUIRE_HTTPS ?? isProduction,
    version: options.version ?? APP_VERSION,
    warnings: Object.freeze(warnings),
  });
}
