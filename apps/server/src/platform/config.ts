/**
 * Environment loading and validation (ARCHITECTURE.md §3, §9;
 * SECURITY.md §3.10). `.env.example` is the authoritative variable list —
 * every variable documented there is modelled below with the same
 * default. Two things this module must never do:
 *
 *  1. Fail one variable at a time. Every problem is collected and
 *     reported together so a developer fixes their `.env` once, not by
 *     playing whack-a-mole across repeated restarts.
 *  2. Echo a secret's value in an error message. Messages name the
 *     variable and the requirement ("COOKIE_SECRET must be at least 32
 *     characters") and nothing else — never `received: "<value>"`.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const APP_MODES = ['development', 'production'] as const;
export type AppMode = (typeof APP_MODES)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type ConfigLogLevel = (typeof LOG_LEVELS)[number];

/** Minimum length required for secrets in production (SECURITY.md §3.10). */
const MIN_SECRET_LENGTH = 32;

// ---------------------------------------------------------------------------
// Small reusable field parsers. Each turns a raw (string | undefined) env
// value into a typed value, applying a default when absent and producing a
// clear, specific issue message when present-but-invalid.
// ---------------------------------------------------------------------------

/** Accepts common truthy/falsy spellings; anything else is a validation error. */
function booleanVar(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((raw) => raw?.trim().toLowerCase())
    .refine(
      (normalised) => normalised === undefined || ['true', 'false', '1', '0'].includes(normalised),
      {
        message: 'must be "true" or "false"',
      },
    )
    .transform((normalised) =>
      normalised === undefined ? defaultValue : normalised === 'true' || normalised === '1',
    );
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
    .transform((raw) => (raw === undefined || raw === '' ? defaultValue : raw));
}

/** A string var with no default — absence becomes `null`, never `undefined` (kept out of AppConfig's optional-property surface). */
function optionalStringVar() {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === '' ? null : raw));
}

function urlVar(defaultValue: string) {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === '' ? defaultValue : raw))
    .pipe(z.string().url('must be a valid URL, e.g. http://host:port'));
}

// ---------------------------------------------------------------------------
// Raw schema. Cross-field, mode-dependent rules (production-only secret
// requirements) are added via superRefine below rather than baked into
// individual fields, since "required" here depends on APP_MODE.
// ---------------------------------------------------------------------------

const rawEnvSchema = z
  .object({
    APP_MODE: z
      .string()
      .optional()
      .transform((raw) => raw?.trim())
      .refine((raw) => raw === undefined || (APP_MODES as readonly string[]).includes(raw), {
        message: `must be one of: ${APP_MODES.join(', ')}`,
      })
      .transform((raw) => (raw === undefined ? 'development' : (raw as AppMode))),

    DANGEROUSLY_USE_REAL_DOCKER: booleanVar(false),

    PORT: portVar(3000),
    HOST: stringVar('0.0.0.0'),

    LOG_LEVEL: z
      .string()
      .optional()
      .transform((raw) => raw?.trim())
      .refine((raw) => raw === undefined || (LOG_LEVELS as readonly string[]).includes(raw), {
        message: `must be one of: ${LOG_LEVELS.join(', ')}`,
      })
      .transform((raw) => (raw === undefined ? 'info' : (raw as ConfigLogLevel))),

    COOKIE_SECRET: optionalStringVar(),
    DATA_DIR: stringVar('./data'),
    BACKUP_DIR: stringVar('./backups'),

    BROKER_URL: urlVar('http://broker:4000'),
    BROKER_SHARED_SECRET: optionalStringVar(),
    BROKER_PORT: portVar(4000),

    DOCKER_SOCKET_PATH: stringVar('/var/run/docker.sock'),

    DMS_CONTAINER_NAME: stringVar('mailserver'),
    DMS_CONTAINER_LABEL: optionalStringVar(),

    RSPAMD_URL: urlVar('http://mailserver:11334'),
    RSPAMD_PASSWORD: optionalStringVar(),

    ENABLE_EXEC_CONSOLE: booleanVar(false),
    ENABLE_HSTS: booleanVar(true),
  })
  .superRefine((data, ctx) => {
    if (data.APP_MODE !== 'production') {
      return;
    }
    for (const [key, value] of [
      ['COOKIE_SECRET', data.COOKIE_SECRET],
      ['BROKER_SHARED_SECRET', data.BROKER_SHARED_SECRET],
    ] as const) {
      if (value === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required in production. Generate one with: openssl rand -hex 32`,
        });
      } else if (value.length < MIN_SECRET_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be at least ${MIN_SECRET_LENGTH} characters in production`,
        });
      }
    }
  });

type RawEnv = z.infer<typeof rawEnvSchema>;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface AppConfig {
  readonly appMode: AppMode;
  readonly isProduction: boolean;

  /**
   * Effective value. Always `false` when `isProduction` — production
   * always uses real drivers, regardless of what was set (§9, and the
   * milestone's explicit "ignored in production" requirement).
   */
  readonly dangerouslyUseRealDocker: boolean;

  readonly port: number;
  readonly host: string;
  readonly logLevel: ConfigLogLevel;

  readonly cookieSecret: string;
  /** True when no COOKIE_SECRET was configured and one was generated for this process only. */
  readonly cookieSecretIsEphemeral: boolean;

  readonly dataDir: string;
  readonly backupDir: string;

  readonly broker: {
    readonly url: string;
    readonly sharedSecret: string;
    /** True when no BROKER_SHARED_SECRET was configured and one was generated for this process only. */
    readonly sharedSecretIsEphemeral: boolean;
    readonly port: number;
  };

  readonly dockerSocketPath: string;

  readonly dms: {
    readonly containerName: string;
    readonly containerLabel: string | null;
  };

  readonly rspamd: {
    readonly url: string;
    readonly password: string | null;
  };

  readonly enableExecConsole: boolean;
  readonly enableHsts: boolean;

  /**
   * Non-secret, operator-facing messages worth logging once at startup
   * (e.g. "using an ephemeral cookie secret"). Never contains a secret
   * value. The caller decides how/whether to log these — this module
   * has no logger dependency, so config can be validated before logging
   * exists.
   */
  readonly warnings: readonly string[];
}

/** Thrown by {@link loadConfig} when the environment is missing or invalid. Never carries a secret value. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const header = 'Invalid configuration — fix the following and restart:';
    super([header, ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function formatZodIssues(issues: readonly z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `${path}: ${issue.message}`;
  });
}

function generateEphemeralSecret(): string {
  // 32 bytes -> 64 hex characters, comfortably over the 32-char minimum.
  return randomBytes(32).toString('hex');
}

/**
 * Loads and validates configuration from `env` (defaults to
 * `process.env`). Throws a single {@link ConfigError} listing every
 * problem at once. Returns a frozen, fully-typed config object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = rawEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatZodIssues(result.error.issues));
  }

  const data: RawEnv = result.data;
  const warnings: string[] = [];

  let cookieSecret = data.COOKIE_SECRET;
  let cookieSecretIsEphemeral = false;
  if (cookieSecret === null) {
    cookieSecret = generateEphemeralSecret();
    cookieSecretIsEphemeral = true;
    warnings.push(
      'COOKIE_SECRET is not set; using a random value generated for this process only. ' +
        'Every restart invalidates existing sessions. Set COOKIE_SECRET for stable sessions (openssl rand -hex 32).',
    );
  }

  let brokerSharedSecret = data.BROKER_SHARED_SECRET;
  let brokerSharedSecretIsEphemeral = false;
  if (brokerSharedSecret === null) {
    brokerSharedSecret = generateEphemeralSecret();
    brokerSharedSecretIsEphemeral = true;
    warnings.push(
      'BROKER_SHARED_SECRET is not set; using a random value generated for this process only. ' +
        'It will not match a real broker. Set BROKER_SHARED_SECRET before enabling DANGEROUSLY_USE_REAL_DOCKER (openssl rand -hex 32).',
    );
  }

  const isProduction = data.APP_MODE === 'production';

  const dangerouslyUseRealDocker = isProduction ? false : data.DANGEROUSLY_USE_REAL_DOCKER;
  if (isProduction && data.DANGEROUSLY_USE_REAL_DOCKER) {
    warnings.push(
      'DANGEROUSLY_USE_REAL_DOCKER=true is set but ignored in production; real drivers are always used there.',
    );
  }

  const config: AppConfig = {
    appMode: data.APP_MODE,
    isProduction,
    dangerouslyUseRealDocker,
    port: data.PORT,
    host: data.HOST,
    logLevel: data.LOG_LEVEL,
    cookieSecret,
    cookieSecretIsEphemeral,
    dataDir: data.DATA_DIR,
    backupDir: data.BACKUP_DIR,
    broker: Object.freeze({
      url: data.BROKER_URL,
      sharedSecret: brokerSharedSecret,
      sharedSecretIsEphemeral: brokerSharedSecretIsEphemeral,
      port: data.BROKER_PORT,
    }),
    dockerSocketPath: data.DOCKER_SOCKET_PATH,
    dms: Object.freeze({
      containerName: data.DMS_CONTAINER_NAME,
      containerLabel: data.DMS_CONTAINER_LABEL,
    }),
    rspamd: Object.freeze({
      url: data.RSPAMD_URL,
      password: data.RSPAMD_PASSWORD,
    }),
    enableExecConsole: data.ENABLE_EXEC_CONSOLE,
    enableHsts: data.ENABLE_HSTS,
    warnings: Object.freeze(warnings),
  };

  return Object.freeze(config);
}
