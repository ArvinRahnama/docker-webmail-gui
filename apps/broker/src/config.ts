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
import { parseVisiblePatterns } from '@dwg/shared';

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

  // The panel's own two containers, addressed the same config-known
  // name-or-label way as the mail container. `PANEL_SERVER_*` is what
  // `panel.restart` resolves and restarts; `PANEL_BROKER_*` is resolved
  // only to keep the broker *visible* in the containers list and to guard
  // `panel.restart` from ever resolving to the broker itself. Defaults
  // match docker/compose.yaml's `container_name:` for each service.
  PANEL_SERVER_CONTAINER_NAME: stringVar('dwg-server'),
  PANEL_SERVER_CONTAINER_LABEL: optionalStringVar(),
  PANEL_BROKER_CONTAINER_NAME: stringVar('dwg-broker'),
  PANEL_BROKER_CONTAINER_LABEL: optionalStringVar(),

  // The webmail-services allowlist (FEATURE_MATRIX.md §22-26). A
  // comma-separated glob list matched against container names and image
  // repo tags; the mail/panel containers are additionally always visible
  // by the identities above. Empty/unset -> the sensible defaults
  // (`DEFAULT_VISIBLE_SERVICE_PATTERNS`, @dwg/shared). Volumes and
  // networks are not listed here: they are derived from the visible
  // containers' own mounts and network attachments, so they stay
  // consistent automatically (`operations.ts`).
  VISIBLE_SERVICE_PATTERNS: z.string().optional(),
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
  readonly panelServer: {
    readonly containerName: string;
    readonly containerLabel: string | null;
  };
  readonly panelBroker: {
    readonly containerName: string;
    readonly containerLabel: string | null;
  };
  readonly visibleServicePatterns: readonly string[];
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
    panelServer: Object.freeze({
      containerName: data.PANEL_SERVER_CONTAINER_NAME,
      containerLabel: data.PANEL_SERVER_CONTAINER_LABEL,
    }),
    panelBroker: Object.freeze({
      containerName: data.PANEL_BROKER_CONTAINER_NAME,
      containerLabel: data.PANEL_BROKER_CONTAINER_LABEL,
    }),
    visibleServicePatterns: Object.freeze([...parseVisiblePatterns(data.VISIBLE_SERVICE_PATTERNS)]),
  };

  return Object.freeze(config);
}
