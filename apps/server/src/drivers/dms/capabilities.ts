/**
 * Capability detection (ARCHITECTURE.md §5.1; `docs/research/01-docker-mailserver.md`
 * §8, §9). At startup and on a schedule, the server probes what a given
 * DMS deployment actually supports and publishes a capability document the
 * UI renders `Unsupported` states from, rather than hardcoding assumptions
 * that would silently drift from the real deployment's env vars.
 *
 * `detectCapabilities` is a pure function over an env-var-shaped record —
 * deliberately independent of *how* those env vars were obtained. Reading
 * the real DMS container's environment at runtime needs either an
 * extended `container.inspect` or an `exec`-based probe, neither of which
 * exists on the broker yet (see `exec-port.ts`'s doc comment for the same
 * gap `RealDmsDriver` hits on the write side). Keeping this function pure
 * means capability logic is fully unit-testable today, independent of
 * when that plumbing lands.
 */

export interface CapabilityStatus {
  readonly supported: boolean;
  /** Human-readable, safe to show an admin. `null` when `supported` is `true`. */
  readonly reason: string | null;
}

function supported(): CapabilityStatus {
  return { supported: true, reason: null };
}

function unsupported(reason: string): CapabilityStatus {
  return { supported: false, reason };
}

/**
 * `empty=FILE` per the research doc §9; `LDAP` and `OIDC` are the other
 * documented values (OIDC "not yet implemented" upstream). Anything else
 * is reported as `UNKNOWN` rather than guessed at — this project's stated
 * preference for reporting reality over assuming a closed set we do not
 * own (ARCHITECTURE.md §11.2, mirrored in `packages/shared/src/broker.ts`'s
 * own choice to leave Docker's state strings open).
 */
export type AccountProvisioner = 'FILE' | 'LDAP' | 'OIDC' | 'UNKNOWN';

export interface DmsCapabilities {
  readonly quotas: CapabilityStatus;
  readonly rspamd: CapabilityStatus;
  readonly clamav: CapabilityStatus;
  readonly fail2ban: CapabilityStatus;
  readonly accountProvisioner: AccountProvisioner;
  /**
   * `false` whenever `accountProvisioner !== 'FILE'`. Local mailbox/alias/
   * quota CRUD writes to files (`postfix-accounts.cf`, `postfix-virtual.cf`,
   * `dovecot-quotas.cf`) that a non-FILE provisioner never reads — per ★8,
   * `listmailuser` itself refuses to run outside `ACCOUNT_PROVISIONER=FILE`.
   * The writes would not error; they would just be silently meaningless,
   * which is exactly the outcome this capability exists to prevent the UI
   * from presenting as a working control.
   */
  readonly localAccountManagement: CapabilityStatus;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Same truthy/falsy vocabulary as `platform/config.ts`'s `booleanVar` — case-insensitive `1`/`true` or `0`/`false`; anything else (including absence) falls back to `defaultValue`. */
function envFlag(env: EnvSource, key: string, defaultValue: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return defaultValue;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return defaultValue;
}

function detectAccountProvisioner(env: EnvSource): AccountProvisioner {
  const raw = env['ACCOUNT_PROVISIONER']?.trim().toUpperCase();
  if (raw === undefined || raw === '') return 'FILE';
  if (raw === 'FILE' || raw === 'LDAP' || raw === 'OIDC') return raw;
  return 'UNKNOWN';
}

export function detectCapabilities(env: EnvSource): DmsCapabilities {
  // Shipped defaults per docs/research/01-docker-mailserver.md §9's own
  // reading convention ("blank means unset/uses the service's internal
  // default"): ENABLE_QUOTAS ships `=1` (on by default); RSPAMD, CLAMAV
  // and FAIL2BAN all ship `=0` (off by default).
  const quotasEnabled = envFlag(env, 'ENABLE_QUOTAS', true);
  const rspamdEnabled = envFlag(env, 'ENABLE_RSPAMD', false);
  const clamavEnabled = envFlag(env, 'ENABLE_CLAMAV', false);
  const fail2banEnabled = envFlag(env, 'ENABLE_FAIL2BAN', false);
  const accountProvisioner = detectAccountProvisioner(env);

  return {
    quotas: quotasEnabled
      ? supported()
      : unsupported('ENABLE_QUOTAS is not set (or is disabled) on this deployment.'),
    rspamd: rspamdEnabled
      ? supported()
      : unsupported('ENABLE_RSPAMD is not set on this deployment.'),
    clamav: clamavEnabled
      ? supported()
      : unsupported('ENABLE_CLAMAV is not set on this deployment.'),
    fail2ban: fail2banEnabled
      ? supported()
      : unsupported('ENABLE_FAIL2BAN is not set on this deployment.'),
    accountProvisioner,
    localAccountManagement:
      accountProvisioner === 'FILE'
        ? supported()
        : unsupported(
            `ACCOUNT_PROVISIONER=${accountProvisioner} — local mailbox/alias/quota management is unsupported because DMS never reads postfix-accounts.cf, postfix-virtual.cf or dovecot-quotas.cf under this provisioner (docs/research/01-docker-mailserver.md ★8).`,
          ),
  };
}
