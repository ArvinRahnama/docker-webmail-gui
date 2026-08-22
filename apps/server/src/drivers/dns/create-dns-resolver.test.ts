import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../platform/config.js';
import {
  createDnsLookupPort,
  createDnsLookupPortFactory,
  DNS_ALWAYS_UNKNOWN_DOMAIN,
  DNS_DEMO_DOMAIN,
} from './create-dns-resolver.js';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { RealDnsLookupPort } from './real-resolver.js';

function silentLogger() {
  return pino({ level: 'silent' });
}

describe('createDnsLookupPort — development mode selects a seeded fake', () => {
  it('returns a FakeDnsLookupPort when APP_MODE=development and DANGEROUSLY_USE_REAL_DOCKER is unset', () => {
    const config = loadConfig({ APP_MODE: 'development' });
    const resolver = createDnsLookupPort(config, silentLogger());
    expect(resolver).toBeInstanceOf(FakeDnsLookupPort);
  });

  it('seeds DNS_DEMO_DOMAIN with a resolvable MX, SPF, DMARC, DKIM and A/PTR chain', async () => {
    const config = loadConfig({ APP_MODE: 'development' });
    const resolver = createDnsLookupPort(config, silentLogger());

    const mx = await resolver.resolveMx(DNS_DEMO_DOMAIN);
    expect(mx.length).toBeGreaterThan(0);

    const spfTxts = await resolver.resolveTxt(DNS_DEMO_DOMAIN);
    expect(spfTxts.flat().some((chunk) => chunk.startsWith('v=spf1'))).toBe(true);

    const dmarcTxts = await resolver.resolveTxt(`_dmarc.${DNS_DEMO_DOMAIN}`);
    expect(dmarcTxts.flat().some((chunk) => chunk.startsWith('v=DMARC1'))).toBe(true);

    const dkimTxts = await resolver.resolveTxt(`mail._domainkey.${DNS_DEMO_DOMAIN}`);
    expect(dkimTxts.flat().some((chunk) => chunk.includes('p='))).toBe(true);

    const addresses = await resolver.resolve4(DNS_DEMO_DOMAIN);
    expect(addresses.length).toBeGreaterThan(0);
    const ptr = await resolver.reverse(addresses[0] as string);
    expect(ptr.length).toBeGreaterThan(0);
  });

  it('seeds DNS_ALWAYS_UNKNOWN_DOMAIN to fail every relevant lookup with a non-authoritative error', async () => {
    const config = loadConfig({ APP_MODE: 'development' });
    const resolver = createDnsLookupPort(config, silentLogger());

    // A non-authoritative code (not ENOTFOUND/ENODATA) is what
    // classifyDnsError (errors.ts) maps to 'unknown' rather than
    // 'missing' — asserting the code directly here pins the fixture's
    // own contract; email-auth.test.ts already covers the
    // code -> 'unknown' state mapping itself.
    await expect(resolver.resolveMx(DNS_ALWAYS_UNKNOWN_DOMAIN)).rejects.toMatchObject({
      code: 'ETIMEOUT',
    });
    await expect(resolver.resolveTxt(DNS_ALWAYS_UNKNOWN_DOMAIN)).rejects.toMatchObject({
      code: 'ETIMEOUT',
    });
    await expect(
      resolver.resolveTxt(`mail._domainkey.${DNS_ALWAYS_UNKNOWN_DOMAIN}`),
    ).rejects.toMatchObject({ code: 'ETIMEOUT' });
    await expect(resolver.resolveTxt(`_dmarc.${DNS_ALWAYS_UNKNOWN_DOMAIN}`)).rejects.toMatchObject({
      code: 'ETIMEOUT',
    });
  });
});

describe('createDnsLookupPortFactory — development mode selects an identically seeded fake', () => {
  it('returns a factory whose resolver also resolves DNS_DEMO_DOMAIN and fails DNS_ALWAYS_UNKNOWN_DOMAIN', async () => {
    const config = loadConfig({ APP_MODE: 'development' });
    const factory = createDnsLookupPortFactory(config, silentLogger());
    const resolver = factory('1.1.1.1');

    const mx = await resolver.resolveMx(DNS_DEMO_DOMAIN);
    expect(mx.length).toBeGreaterThan(0);
    await expect(resolver.resolveMx(DNS_ALWAYS_UNKNOWN_DOMAIN)).rejects.toMatchObject({
      code: 'ETIMEOUT',
    });
  });
});

describe('createDnsLookupPort / createDnsLookupPortFactory — production always uses the real resolver', () => {
  const productionEnv = {
    APP_MODE: 'production',
    COOKIE_SECRET: 'a'.repeat(32),
    BROKER_SHARED_SECRET: 'b'.repeat(32),
  };

  it('returns a RealDnsLookupPort in production', () => {
    const config = loadConfig(productionEnv);
    const resolver = createDnsLookupPort(config, silentLogger());
    expect(resolver).toBeInstanceOf(RealDnsLookupPort);
  });

  it('returns a factory backed by RealDnsLookupPort in production', () => {
    const config = loadConfig(productionEnv);
    const factory = createDnsLookupPortFactory(config, silentLogger());
    expect(factory('1.1.1.1')).toBeInstanceOf(RealDnsLookupPort);
  });
});
