import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../platform/config.js';
import { createDmsDriver } from './create-dms-driver.js';
import { FakeDmsDriver } from './fake-dms-driver.js';
import { RealDmsDriver } from './real-dms-driver.js';
import type { DmsExecPort } from './exec-port.js';

function silentLogger() {
  return pino({ level: 'silent' });
}

function stubExecPort(): DmsExecPort {
  return {
    readFile: () => Promise.resolve(null),
    exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    getEnv: () => Promise.resolve({}),
    readDkimPublicKeyFile: () => Promise.resolve(null),
  };
}

describe('createDmsDriver — development mode selects the fake driver by default', () => {
  it('returns a FakeDmsDriver when APP_MODE=development and DANGEROUSLY_USE_REAL_DOCKER is unset', () => {
    const config = loadConfig({ APP_MODE: 'development' });
    const driver = createDmsDriver(config, silentLogger());
    expect(driver).toBeInstanceOf(FakeDmsDriver);
  });

  it('returns a FakeDmsDriver when APP_MODE is entirely unset (defaults to development)', () => {
    const config = loadConfig({});
    const driver = createDmsDriver(config, silentLogger());
    expect(driver).toBeInstanceOf(FakeDmsDriver);
  });

  it('returns a FakeDmsDriver in development even if an execPort happens to be passed — it is simply unused', () => {
    const config = loadConfig({ APP_MODE: 'development' });
    const driver = createDmsDriver(config, silentLogger(), stubExecPort());
    expect(driver).toBeInstanceOf(FakeDmsDriver);
  });
});

describe('createDmsDriver — explicit opt-in to a real docker-mailserver in development', () => {
  it('returns a RealDmsDriver when DANGEROUSLY_USE_REAL_DOCKER=true and an execPort is supplied', () => {
    const config = loadConfig({ APP_MODE: 'development', DANGEROUSLY_USE_REAL_DOCKER: 'true' });
    expect(config.dangerouslyUseRealDocker).toBe(true); // sanity check on the fixture itself
    const driver = createDmsDriver(config, silentLogger(), stubExecPort());
    expect(driver).toBeInstanceOf(RealDmsDriver);
  });

  it('throws — loudly, not a silent fallback to the fake — when DANGEROUSLY_USE_REAL_DOCKER=true but no execPort is supplied', () => {
    const config = loadConfig({ APP_MODE: 'development', DANGEROUSLY_USE_REAL_DOCKER: 'true' });
    expect(() => createDmsDriver(config, silentLogger())).toThrow(/DmsExecPort/);
  });
});

describe('createDmsDriver — production always uses the real driver', () => {
  const productionEnv = {
    APP_MODE: 'production',
    COOKIE_SECRET: 'a'.repeat(32),
    BROKER_SHARED_SECRET: 'b'.repeat(32),
  };

  it('returns a RealDmsDriver in production when an execPort is supplied', () => {
    const config = loadConfig(productionEnv);
    const driver = createDmsDriver(config, silentLogger(), stubExecPort());
    expect(driver).toBeInstanceOf(RealDmsDriver);
  });

  it('throws in production rather than silently falling back to the fake when no execPort is supplied', () => {
    const config = loadConfig(productionEnv);
    expect(() => createDmsDriver(config, silentLogger())).toThrow(/DmsExecPort/);
  });

  it('still requires a real driver in production even if DANGEROUSLY_USE_REAL_DOCKER=true was set — because loadConfig already forces the flag to false there, not because of any check in createDmsDriver itself', () => {
    const config = loadConfig({ ...productionEnv, DANGEROUSLY_USE_REAL_DOCKER: 'true' });
    expect(config.dangerouslyUseRealDocker).toBe(false); // loadConfig's own guarantee
    const driver = createDmsDriver(config, silentLogger(), stubExecPort());
    expect(driver).toBeInstanceOf(RealDmsDriver);
  });
});
