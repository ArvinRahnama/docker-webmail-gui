/**
 * The config editor's server-side allowlist (M10 — SECURITY.md §3.10
 * "Editable config files are a server-side allowlist of DMS paths"; this
 * module is the settings-shaped equivalent of that rule). No route in
 * `config.routes.ts` ever accepts a client-supplied key outside
 * {@link SETTINGS_ALLOWLIST} — an unknown key is rejected the exact same
 * way an out-of-allowlist path would be (`config.service.ts`'s
 * `validate`).
 *
 * **Scope decision, narrowing `@dwg/shared`'s `config-editor.ts` header
 * comment the same deliberate way that file's own header already narrows
 * FEATURE_MATRIX §29:** every setting below is one of *this panel's own*
 * environment-backed settings (`platform/config.ts`'s `AppConfig`), not a
 * DMS *container* environment variable. Two independent reasons, not one:
 *
 *  1. The broker has no operation to read a container's environment at
 *     all (`ContainerInspectResponseSchema` deliberately omits `Env`,
 *     `@dwg/shared` `broker.ts`) — reading it back out would be a new
 *     surface this milestone was never asked to add, and the architecture
 *     invariant (AGENT_BRIEF.md §2) is conservative about broker growth
 *     by design.
 *  2. Docker cannot update a *running* container's environment at all —
 *     only `container.create` can, which the broker deliberately lacks.
 *     Every DMS-side setting would therefore be `needs-recreate` and
 *     silently unappliable, which is exactly the "control ship the
 *     backend cannot perform" AGENT_BRIEF.md §3 rule 1 forbids. Nothing
 *     below is `needs-recreate` for the same reason `update.apply` is
 *     absent from `JOB_TYPES` — see `modules/updates/updates.service.ts`.
 *
 * `classification` is `'needs-restart'` for everything editable here
 * because `AppConfig` is loaded once, frozen, at process start
 * (`platform/config.ts`) — there is no live-reload path in this pass, so
 * `'editable-live'` has no honest entry yet either. `apply()`
 * (`config.service.ts`) persists a change into the `settings` table and
 * says plainly that a restart is required; it does not, and does not
 * claim to, change this process's running behaviour immediately.
 */
import type { AppConfig } from '../../platform/config.js';
import type { ConfigSetting, ConfigSettingClassification } from '@dwg/shared';

export interface SettingDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly classification: ConfigSettingClassification;
  readonly secret: boolean;
  /** Reads the setting's *currently running* value (never the pending, unapplied override) straight from the live `AppConfig` — see the module header on why "running" and "saved" can legitimately differ here. */
  readonly getValue: (config: AppConfig) => string | null;
}

function boolToString(value: boolean): string {
  return value ? 'true' : 'false';
}

export const SETTINGS_ALLOWLIST: readonly SettingDefinition[] = [
  // ---------------------------------------------------------------------
  // read-only — informational, or unsafe to change through this editor
  // even though the underlying value is a real, ordinary env var.
  // ---------------------------------------------------------------------
  {
    key: 'DMS_CONTAINER_NAME',
    label: 'Managed container name',
    description:
      'The container name every module in this panel resolves as "the" mail server. Read-only here: changing it silently repoints every other feature at a different container, which this editor\'s per-key apply flow is not the right tool for. Change it via the environment and restart.',
    classification: 'read-only',
    secret: false,
    getValue: (config) => config.dms.containerName,
  },
  {
    key: 'BROKER_SHARED_SECRET',
    label: 'Broker shared secret',
    description:
      "Authenticates every server -> broker request. Read-only here: the broker has no API to receive a new value for its own copy, so editing only this side would break connectivity, not rotate the secret. Rotate by updating both processes' environment and restarting both.",
    classification: 'read-only',
    secret: true,
    getValue: (config) => config.broker.sharedSecret,
  },

  // ---------------------------------------------------------------------
  // needs-restart — real settings, persisted on apply, but this process
  // only reads `AppConfig` once at startup (see the module header).
  // ---------------------------------------------------------------------
  {
    key: 'LOG_LEVEL',
    label: 'Log level',
    description: 'Pino log verbosity: fatal, error, warn, info, debug, or trace.',
    classification: 'needs-restart',
    secret: false,
    getValue: (config) => config.logLevel,
  },
  {
    key: 'ENABLE_EXEC_CONSOLE',
    label: 'Restricted command console',
    description:
      'Enables the allowlisted diagnostic command console (FEATURE_MATRIX.md §32). Off by default — exec into the mail container is a meaningful capability even restricted to a fixed command set.',
    classification: 'needs-restart',
    secret: false,
    getValue: (config) => boolToString(config.enableExecConsole),
  },
  {
    key: 'ENABLE_HSTS',
    label: 'HTTP Strict Transport Security',
    description:
      'Sends Strict-Transport-Security on responses. Turn off only for a plain-HTTP LAN install, where forcing HTTPS would lock an administrator out rather than protect them.',
    classification: 'needs-restart',
    secret: false,
    getValue: (config) => boolToString(config.enableHsts),
  },
  {
    key: 'COOKIE_SECURE',
    label: 'Secure session cookie',
    description:
      'Whether the session cookie carries the Secure attribute. Turn off only for a plain-HTTP LAN install, where forcing it would silently stop the browser from ever sending the cookie back.',
    classification: 'needs-restart',
    secret: false,
    getValue: (config) => boolToString(config.cookieSecure),
  },
  {
    key: 'SESSION_ABSOLUTE_TTL_HOURS',
    label: 'Session absolute lifetime (hours)',
    description: 'Absolute session lifetime in hours, regardless of activity.',
    classification: 'needs-restart',
    secret: false,
    getValue: (config) => String(config.session.absoluteTtlHours),
  },
  {
    key: 'SESSION_IDLE_TTL_HOURS',
    label: 'Session idle lifetime (hours)',
    description:
      'Idle session lifetime in hours — expires this long after last use, even inside the absolute window.',
    classification: 'needs-restart',
    secret: false,
    getValue: (config) => String(config.session.idleTtlHours),
  },
  {
    key: 'RSPAMD_URL',
    label: 'Rspamd controller URL',
    description: 'Base URL of the Rspamd controller HTTP API.',
    classification: 'needs-restart',
    secret: false,
    getValue: (config) => config.rspamd.url,
  },
  {
    key: 'RSPAMD_PASSWORD',
    label: 'Rspamd controller password',
    description:
      "Password for the Rspamd controller's Password header. Leave unset only if the controller has no password configured.",
    classification: 'needs-restart',
    secret: true,
    getValue: (config) => config.rspamd.password,
  },
  {
    key: 'COOKIE_SECRET',
    label: 'Cookie signing secret',
    description:
      'Signs the session cookie. Changing this immediately invalidates every existing session on the next restart — every administrator, including you, will need to log in again.',
    classification: 'needs-restart',
    secret: true,
    getValue: (config) => config.cookieSecret,
  },
];

export function findSettingDefinition(key: string): SettingDefinition | null {
  return SETTINGS_ALLOWLIST.find((setting) => setting.key === key) ?? null;
}

/** Builds the client-facing `ConfigSetting` for one definition, masking a secret's value unless `reveal` is true — the same mask/reveal split `config.service.ts`'s `describe`/`reveal` methods are named after. */
export function describeSetting(
  definition: SettingDefinition,
  config: AppConfig,
  reveal: boolean,
): ConfigSetting {
  const rawValue = definition.getValue(config);
  const masked = definition.secret && !reveal;
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    classification: definition.classification,
    secret: definition.secret,
    masked,
    value: masked ? null : rawValue,
  };
}
