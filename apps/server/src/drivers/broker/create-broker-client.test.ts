import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../platform/config.js';
import { createBrokerClient } from './create-broker-client.js';
import { FakeBrokerClient } from './fake-broker-client.js';
import { RealBrokerClient } from './real-broker-client.js';

function silentLogger() {
  return pino({ level: 'silent' });
}

describe('createBrokerClient — development mode selects the fake client by default', () => {
  it('returns a FakeBrokerClient when APP_MODE=development and DANGEROUSLY_USE_REAL_DOCKER is unset', () => {
    const config = loadConfig({ APP_MODE: 'development' });
    const client = createBrokerClient(config, silentLogger());
    expect(client).toBeInstanceOf(FakeBrokerClient);
  });

  it('returns a FakeBrokerClient when APP_MODE is entirely unset (defaults to development)', () => {
    const config = loadConfig({});
    const client = createBrokerClient(config, silentLogger());
    expect(client).toBeInstanceOf(FakeBrokerClient);
  });
});

describe('createBrokerClient — explicit opt-in to a real Docker daemon in development', () => {
  it('returns a RealBrokerClient when DANGEROUSLY_USE_REAL_DOCKER=true in development', () => {
    const config = loadConfig({
      APP_MODE: 'development',
      DANGEROUSLY_USE_REAL_DOCKER: 'true',
    });
    expect(config.dangerouslyUseRealDocker).toBe(true); // sanity check on the fixture itself
    const client = createBrokerClient(config, silentLogger());
    expect(client).toBeInstanceOf(RealBrokerClient);
  });
});

describe('createBrokerClient — production always uses the real client', () => {
  const productionEnv = {
    APP_MODE: 'production',
    COOKIE_SECRET: 'a'.repeat(32),
    BROKER_SHARED_SECRET: 'b'.repeat(32),
  };

  it('returns a RealBrokerClient in production', () => {
    const config = loadConfig(productionEnv);
    const client = createBrokerClient(config, silentLogger());
    expect(client).toBeInstanceOf(RealBrokerClient);
  });

  it('still returns a RealBrokerClient in production even if DANGEROUSLY_USE_REAL_DOCKER=true was set — because loadConfig already forces the flag to false there, not because of any check in createBrokerClient itself', () => {
    const config = loadConfig({ ...productionEnv, DANGEROUSLY_USE_REAL_DOCKER: 'true' });
    expect(config.dangerouslyUseRealDocker).toBe(false); // loadConfig's own guarantee
    const client = createBrokerClient(config, silentLogger());
    expect(client).toBeInstanceOf(RealBrokerClient);
  });
});
