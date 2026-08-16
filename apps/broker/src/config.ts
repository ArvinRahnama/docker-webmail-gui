/**
 * Broker environment loading and validation. Deliberately smaller than
 * `apps/server/src/platform/config.ts` — this process has exactly one
 * job (ARCHITECTURE.md §6, §11), so it has one small, self-contained
 * config surface. The "collect every problem, never echo a secret"
 * rules are duplicated in spirit from the server's config module, not
 * imported from it: the two apps are separate deployables that share
 * only `@dwg/shared`, by design (ARCHITECTURE.md §4) — the privileged
 * tier must never depend on the web tier's package, or vice versa.
 *
 * Unlike the server's `COOKIE_SECRET`/`BROKER_SHARED_SECRET` (which fall
 * back to an ephemeral, generated value with a warning — convenient for
 * a developer who never intends to run a real broker), the broker
 * *itself* always requires `BROKER_SHARED_SECRET` to be set, with no
 * fallback, in every mode. There is no "development mode" for this
 * process the way there is for the server's driver selection
 * (ARCHITECTURE.md §9) — the broker either holds the real Docker socket
 * or it does not run — so silently starting it with a generated secret
 * nobody configured anywhere else would be a footgun, not a convenience.
 */
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type BrokerLogLevel = (typeof LOG_LEVELS)[number];

/** Matches SECURITY.md §3.10's minimum for every secret in this project. */
const MIN_SECRET_LENGTH = 32;

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

function optionalStringVar() {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === '' ? null : raw));
}

const rawEnvSchema = z.object({
  BROKER_PORT: portVar(4000),
  BROKER_HOST: stringVar('0.0.0.0'),

  LOG_LEVEL: z
    .string()
    .optional()
    .transform((raw) => raw?.trim())
    .refine((raw) => raw === undefined || (LOG_LEVELS as readonly string[]).includes(raw), {
      message: `must be one of: ${LOG_LEVELS.join(', ')}`,
    })
    .transform((raw) => (raw === undefined ? 'info' : (raw as BrokerLogLevel))),

  // Required, unconditionally — see the file header for why this has no
  // ephemeral-secret fallback the way the server's config does.
  BROKER_SHARED_SECRET: z
    .string(`BROKER_SHARED_SECRET is required. Generate one with: openssl rand -hex 32`)
    .min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`),

  DOCKER_SOCKET_PATH: stringVar('/var/run/docker.sock'),

  DMS_CONTAINER_NAME: stringVar('mailserver'),
  DMS_CONTAINER_LABEL: optionalStringVar(),
});

export interface BrokerConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: BrokerLogLevel;
  readonly sharedSecret: string;
  readonly dockerSocketPath: string;
  readonly dms: {
    readonly containerName: string;
    readonly containerLabel: string | null;
  };
}

/** Thrown by {@link loadBrokerConfig} when the environment is missing or invalid. Never carries a secret value. */
export class BrokerConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const header = 'Invalid broker configuration — fix the following and restart:';
    super([header, ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'BrokerConfigError';
    this.problems = problems;
  }
}

function formatZodIssues(issues: readonly z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `${path}: ${issue.message}`;
  });
}

/** Loads and validates configuration from `env` (defaults to `process.env`). Throws one {@link BrokerConfigError} listing every problem at once. Returns a frozen, fully-typed config object. */
export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const result = rawEnvSchema.safeParse(env);
  if (!result.success) {
    throw new BrokerConfigError(formatZodIssues(result.error.issues));
  }

  const data = result.data;
  const config: BrokerConfig = {
    port: data.BROKER_PORT,
    host: data.BROKER_HOST,
    logLevel: data.LOG_LEVEL,
    sharedSecret: data.BROKER_SHARED_SECRET,
    dockerSocketPath: data.DOCKER_SOCKET_PATH,
    dms: Object.freeze({
      containerName: data.DMS_CONTAINER_NAME,
      containerLabel: data.DMS_CONTAINER_LABEL,
    }),
  };

  return Object.freeze(config);
}
