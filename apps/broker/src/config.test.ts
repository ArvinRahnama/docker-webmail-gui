import { describe, expect, it } from 'vitest';
import { BrokerConfigError, loadBrokerConfig } from './config.js';

const VALID_SECRET = 'a'.repeat(32);

describe('loadBrokerConfig — defaults', () => {
  it('applies every documented default when only the required secret is set', () => {
    const config = loadBrokerConfig({ BROKER_SHARED_SECRET: VALID_SECRET });

    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('info');
    expect(config.dockerSocketPath).toBe('/var/run/docker.sock');
    expect(config.dms.containerName).toBe('mailserver');
    expect(config.dms.containerLabel).toBeNull();
    expect(config.sharedSecret).toBe(VALID_SECRET);
    // Panel identities default to compose's own container_name values.
    expect(config.panelServer).toEqual({ containerName: 'dwg-server', containerLabel: null });
    expect(config.panelBroker).toEqual({ containerName: 'dwg-broker', containerLabel: null });
    // Visible-service patterns default to the sensible webmail set.
    expect(config.visibleServicePatterns).toEqual([
      '*mailserver*',
      'roundcube*',
      '*docker-webmail-gui*',
    ]);
  });

  it('returns a frozen object', () => {
    const config = loadBrokerConfig({ BROKER_SHARED_SECRET: VALID_SECRET });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.dms)).toBe(true);
  });

  it('honours overrides for every field', () => {
    const config = loadBrokerConfig({
      BROKER_SHARED_SECRET: VALID_SECRET,
      BROKER_PORT: '5000',
      BROKER_HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      DOCKER_SOCKET_PATH: '/custom/docker.sock',
      DMS_CONTAINER_NAME: 'my-mail',
      DMS_CONTAINER_LABEL: 'role=mail',
      PANEL_SERVER_CONTAINER_NAME: 'panel-web',
      PANEL_SERVER_CONTAINER_LABEL: 'role=server',
      PANEL_BROKER_CONTAINER_NAME: 'panel-broker',
      VISIBLE_SERVICE_PATTERNS: 'roundcube*, webmail-*',
    });

    expect(config.port).toBe(5000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.logLevel).toBe('debug');
    expect(config.dockerSocketPath).toBe('/custom/docker.sock');
    expect(config.dms.containerName).toBe('my-mail');
    expect(config.dms.containerLabel).toBe('role=mail');
    expect(config.panelServer).toEqual({
      containerName: 'panel-web',
      containerLabel: 'role=server',
    });
    expect(config.panelBroker).toEqual({ containerName: 'panel-broker', containerLabel: null });
    expect(config.visibleServicePatterns).toEqual(['roundcube*', 'webmail-*']);
  });
});

describe('loadBrokerConfig — BROKER_SHARED_SECRET is required unconditionally', () => {
  it('throws a BrokerConfigError when unset', () => {
    let caught: BrokerConfigError | undefined;
    try {
      loadBrokerConfig({});
    } catch (err) {
      caught = err as BrokerConfigError;
    }

    expect(caught).toBeInstanceOf(BrokerConfigError);
    expect(caught!.problems.some((p) => p.startsWith('BROKER_SHARED_SECRET'))).toBe(true);
    expect(caught!.message).toContain('BROKER_SHARED_SECRET');
  });

  it('throws when set but shorter than the minimum, with a length-specific message', () => {
    let caught: BrokerConfigError | undefined;
    try {
      loadBrokerConfig({ BROKER_SHARED_SECRET: 'too-short' });
    } catch (err) {
      caught = err as BrokerConfigError;
    }

    expect(caught).toBeInstanceOf(BrokerConfigError);
    expect(caught!.problems.some((p) => p.includes('at least 32 characters'))).toBe(true);
  });

  it('never echoes the invalid secret value in the error message', () => {
    const secretLookingValue = 'not-long-enough-but-distinctive-xyz123';
    let caught: BrokerConfigError | undefined;
    try {
      loadBrokerConfig({ BROKER_SHARED_SECRET: secretLookingValue.slice(0, 10) });
    } catch (err) {
      caught = err as BrokerConfigError;
    }

    expect(caught!.message).not.toContain(secretLookingValue.slice(0, 10));
  });

  it('does not fall back to an ephemeral secret the way the server config does', () => {
    expect(() => loadBrokerConfig({})).toThrow(BrokerConfigError);
  });
});

describe('loadBrokerConfig — invalid values', () => {
  it('rejects an out-of-range port', () => {
    expect(() =>
      loadBrokerConfig({ BROKER_SHARED_SECRET: VALID_SECRET, BROKER_PORT: '0' }),
    ).toThrow(BrokerConfigError);
    expect(() =>
      loadBrokerConfig({ BROKER_SHARED_SECRET: VALID_SECRET, BROKER_PORT: '70000' }),
    ).toThrow(BrokerConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() =>
      loadBrokerConfig({ BROKER_SHARED_SECRET: VALID_SECRET, LOG_LEVEL: 'chatty' }),
    ).toThrow(BrokerConfigError);
  });

  it('collects multiple problems into a single error', () => {
    let caught: BrokerConfigError | undefined;
    try {
      loadBrokerConfig({ BROKER_PORT: '0', LOG_LEVEL: 'chatty' });
    } catch (err) {
      caught = err as BrokerConfigError;
    }

    expect(caught).toBeInstanceOf(BrokerConfigError);
    expect(caught!.problems.length).toBeGreaterThanOrEqual(3);
  });
});
