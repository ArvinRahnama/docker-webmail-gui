import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from './config.js';

/** Deliberately under the 32-character minimum, so tests below exercise the "too short" path, not "missing". */
const SHORT_SECRET = 'short-secret-value';

/** A production env with both required secrets present and valid, for tests that only want to vary one thing. */
function validProductionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_MODE: 'production',
    COOKIE_SECRET: 'a'.repeat(32),
    BROKER_SHARED_SECRET: 'b'.repeat(32),
    ...overrides,
  };
}

describe('loadConfig — defaults', () => {
  it('applies every documented default in development with no environment set', () => {
    const config = loadConfig({});

    expect(config.appMode).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.dangerouslyUseRealDocker).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('info');
    expect(config.dataDir).toBe('./data');
    expect(config.backupDir).toBe('./backups');
    expect(config.broker.url).toBe('http://broker:4000');
    expect(config.broker.port).toBe(4000);
    expect(config.dockerSocketPath).toBe('/var/run/docker.sock');
    expect(config.dms.containerName).toBe('mailserver');
    expect(config.dms.containerLabel).toBeNull();
    expect(config.rspamd.url).toBe('http://mailserver:11334');
    expect(config.rspamd.password).toBeNull();
    expect(config.enableExecConsole).toBe(false);
    expect(config.enableHsts).toBe(true);
    expect(config.cookieSecure).toBe(true);
    expect(config.session.absoluteTtlHours).toBe(12);
    expect(config.session.idleTtlHours).toBe(2);
    expect(config.bootstrapAdmin.email).toBeNull();
    expect(config.bootstrapAdmin.password).toBeNull();
  });

  it('returns a frozen object', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('loadConfig — development secret fallback', () => {
  it('generates an ephemeral cookie secret and broker shared secret when unset, each usable (>=32 chars)', () => {
    const config = loadConfig({});

    expect(config.cookieSecretIsEphemeral).toBe(true);
    expect(config.cookieSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.broker.sharedSecretIsEphemeral).toBe(true);
    expect(config.broker.sharedSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('warns about ephemeral secrets without ever including the generated value in the warning text', () => {
    const config = loadConfig({});

    expect(config.warnings.some((w) => w.includes('COOKIE_SECRET'))).toBe(true);
    expect(config.warnings.some((w) => w.includes('BROKER_SHARED_SECRET'))).toBe(true);
    for (const warning of config.warnings) {
      expect(warning).not.toContain(config.cookieSecret);
      expect(warning).not.toContain(config.broker.sharedSecret);
    }
  });

  it('does not generate an ephemeral secret when one is explicitly configured', () => {
    const config = loadConfig({
      COOKIE_SECRET: 'c'.repeat(40),
      BROKER_SHARED_SECRET: 'd'.repeat(40),
    });
    expect(config.cookieSecretIsEphemeral).toBe(false);
    expect(config.broker.sharedSecretIsEphemeral).toBe(false);
    expect(config.cookieSecret).toBe('c'.repeat(40));
  });
});

describe('loadConfig — production enforcement', () => {
  it('accepts a valid production config', () => {
    const config = loadConfig(validProductionEnv());
    expect(config.isProduction).toBe(true);
    expect(config.cookieSecretIsEphemeral).toBe(false);
    expect(config.broker.sharedSecretIsEphemeral).toBe(false);
  });

  it('forces dangerouslyUseRealDocker to false in production and warns, even when the env var says true', () => {
    const config = loadConfig(validProductionEnv({ DANGEROUSLY_USE_REAL_DOCKER: 'true' }));
    expect(config.dangerouslyUseRealDocker).toBe(false);
    expect(config.warnings.some((w) => w.includes('DANGEROUSLY_USE_REAL_DOCKER'))).toBe(true);
  });

  it('throws one ConfigError naming every missing required secret at once, not one at a time', () => {
    expect(() => loadConfig({ APP_MODE: 'production' })).toThrow(ConfigError);

    let caught: ConfigError | undefined;
    try {
      loadConfig({ APP_MODE: 'production' });
    } catch (err) {
      caught = err as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught!.problems.some((p) => p.startsWith('COOKIE_SECRET'))).toBe(true);
    expect(caught!.problems.some((p) => p.startsWith('BROKER_SHARED_SECRET'))).toBe(true);
    // Both problems must be visible in the single aggregated message too.
    expect(caught!.message).toContain('COOKIE_SECRET');
    expect(caught!.message).toContain('BROKER_SHARED_SECRET');
  });

  it('reports a length problem (not a presence problem) for a too-short production secret', () => {
    let caught: ConfigError | undefined;
    try {
      loadConfig(
        validProductionEnv({ COOKIE_SECRET: SHORT_SECRET, BROKER_SHARED_SECRET: SHORT_SECRET }),
      );
    } catch (err) {
      caught = err as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught!.problems.some((p) => p.includes('COOKIE_SECRET') && p.includes('32'))).toBe(
      true,
    );
    expect(
      caught!.problems.some((p) => p.includes('BROKER_SHARED_SECRET') && p.includes('32')),
    ).toBe(true);
  });

  it('never includes a secret value anywhere in the thrown error, even the invalid value that was offered', () => {
    expect(SHORT_SECRET.length).toBeLessThan(32); // sanity: this test only means something if the value is actually invalid

    let caught: ConfigError | undefined;
    try {
      loadConfig(
        validProductionEnv({ COOKIE_SECRET: SHORT_SECRET, BROKER_SHARED_SECRET: SHORT_SECRET }),
      );
    } catch (err) {
      caught = err as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught!.message).not.toContain(SHORT_SECRET);
    for (const problem of caught!.problems) {
      expect(problem).not.toContain(SHORT_SECRET);
    }
  });

  it('does not enforce the production secret requirements outside production', () => {
    // APP_MODE defaults to development, so no COOKIE_SECRET/BROKER_SHARED_SECRET at all must not throw.
    expect(() => loadConfig({})).not.toThrow();
  });
});

describe('loadConfig — M3: cookie security, session TTLs, bootstrap admin', () => {
  it('honours COOKIE_SECURE=false for plain-HTTP LAN installs', () => {
    expect(loadConfig({ COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('parses fractional session TTL hours', () => {
    const config = loadConfig({
      SESSION_ABSOLUTE_TTL_HOURS: '24',
      SESSION_IDLE_TTL_HOURS: '0.5',
    });
    expect(config.session.absoluteTtlHours).toBe(24);
    expect(config.session.idleTtlHours).toBe(0.5);
  });

  it('rejects a zero or negative session TTL', () => {
    expect(() => loadConfig({ SESSION_IDLE_TTL_HOURS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ SESSION_ABSOLUTE_TTL_HOURS: '-1' })).toThrow(ConfigError);
  });

  it('accepts a matched bootstrap admin email + password pair', () => {
    const config = loadConfig({
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'a-bootstrap-password',
    });
    expect(config.bootstrapAdmin.email).toBe('admin@example.com');
    expect(config.bootstrapAdmin.password).toBe('a-bootstrap-password');
  });

  it('rejects a bootstrap email without a matching password, and vice versa', () => {
    expect(() => loadConfig({ BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ BOOTSTRAP_ADMIN_PASSWORD: 'only-a-password' })).toThrow(ConfigError);
  });

  it('rejects a malformed bootstrap admin email', () => {
    expect(() =>
      loadConfig({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email', BOOTSTRAP_ADMIN_PASSWORD: 'x' }),
    ).toThrow(ConfigError);
  });
});

describe('loadConfig — general validation aggregation', () => {
  it('collects multiple unrelated invalid values into a single error', () => {
    let caught: ConfigError | undefined;
    try {
      loadConfig({ APP_MODE: 'nonsense', PORT: 'not-a-number', LOG_LEVEL: 'shout' });
    } catch (err) {
      caught = err as ConfigError;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught!.problems.some((p) => p.startsWith('APP_MODE'))).toBe(true);
    expect(caught!.problems.some((p) => p.startsWith('PORT'))).toBe(true);
    expect(caught!.problems.some((p) => p.startsWith('LOG_LEVEL'))).toBe(true);
    expect(caught!.problems.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an out-of-range port with a clear message', () => {
    expect(() => loadConfig({ PORT: '999999' })).toThrow(ConfigError);
  });

  it('rejects a malformed BROKER_URL', () => {
    expect(() => loadConfig({ BROKER_URL: 'not-a-url' })).toThrow(ConfigError);
  });
});
