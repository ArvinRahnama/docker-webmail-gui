/**
 * Driver selection, and the change M16 made to it.
 *
 * This file used to assert that production **threw** — that
 * `createDmsDriver` refused to construct because `DmsExecPort` had no
 * implementation, and that refusing loudly beat silently serving fake
 * data in a real deployment. That was the right behaviour for a port
 * nobody could implement, and it is why the server could not start in
 * production at all.
 *
 * The port is implementable now (`BrokerDmsExecPort`, over the same
 * `BrokerClient` every Docker operation already uses), so the throw is
 * gone and these tests assert the opposite: production selects the real
 * driver and hands it an adapter, without being given one.
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../platform/config.js';
import { FakeBrokerClient } from '../broker/fake-broker-client.js';
import type { BrokerClient } from '../broker/types.js';
import { createDmsDriver } from './create-dms-driver.js';
import { FakeDmsDriver } from './fake-dms-driver.js';
import { RealDmsDriver } from './real-dms-driver.js';

function silentLogger() {
  return pino({ level: 'silent' });
}

function broker(): BrokerClient {
  return new FakeBrokerClient();
}

describe('createDmsDriver — development mode selects the fake driver by default', () => {
  it('returns a FakeDmsDriver when APP_MODE=development and DANGEROUSLY_USE_REAL_DOCKER is unset', () => {
    const config = loadConfig({ APP_MODE: 'development' });
    expect(createDmsDriver(config, silentLogger(), broker())).toBeInstanceOf(FakeDmsDriver);
  });

  it('returns a FakeDmsDriver when APP_MODE is entirely unset (defaults to development)', () => {
    const config = loadConfig({});
    expect(createDmsDriver(config, silentLogger(), broker())).toBeInstanceOf(FakeDmsDriver);
  });
});

describe('createDmsDriver — explicit opt-in to a real docker-mailserver in development', () => {
  it('returns a RealDmsDriver when DANGEROUSLY_USE_REAL_DOCKER=true', () => {
    const config = loadConfig({ APP_MODE: 'development', DANGEROUSLY_USE_REAL_DOCKER: 'true' });
    expect(config.dangerouslyUseRealDocker).toBe(true); // sanity check on the fixture itself
    expect(createDmsDriver(config, silentLogger(), broker())).toBeInstanceOf(RealDmsDriver);
  });
});

describe('createDmsDriver — production uses the real driver, and can actually build one', () => {
  const productionEnv = {
    APP_MODE: 'production',
    COOKIE_SECRET: 'a'.repeat(32),
    BROKER_SHARED_SECRET: 'b'.repeat(32),
  };

  it('returns a RealDmsDriver with no execPort supplied — the regression that stopped the server booting', () => {
    const config = loadConfig(productionEnv);
    // Before M16 this line threw: "a real DmsExecPort is required ... none
    // was provided". Nothing supplies one here on purpose — the factory
    // building its own adapter from the broker client is the fix.
    const driver = createDmsDriver(config, silentLogger(), broker());
    expect(driver).toBeInstanceOf(RealDmsDriver);
  });

  it('does not fall back to the fake driver in production', () => {
    const config = loadConfig(productionEnv);
    expect(createDmsDriver(config, silentLogger(), broker())).not.toBeInstanceOf(FakeDmsDriver);
  });

  it('still uses the real driver when DANGEROUSLY_USE_REAL_DOCKER=true was set — because loadConfig already forces the flag to false there, not because of any check in createDmsDriver itself', () => {
    const config = loadConfig({ ...productionEnv, DANGEROUSLY_USE_REAL_DOCKER: 'true' });
    expect(config.dangerouslyUseRealDocker).toBe(false); // loadConfig's own guarantee
    expect(createDmsDriver(config, silentLogger(), broker())).toBeInstanceOf(RealDmsDriver);
  });
});
