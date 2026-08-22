/**
 * Selects the default {@link DnsLookupPort}, mirroring
 * `drivers/dms/create-dms-driver.ts`. Unlike the DMS driver, a real DNS
 * resolver carries none of the host-compromise risk `DANGEROUSLY_USE_REAL_DOCKER`
 * exists to gate — this reuses that same flag purely for the *dev-ergonomics*
 * convention it already establishes ("real external calls only in
 * production, or when explicitly opted into locally"), not because DNS
 * resolution is itself dangerous. The default stays fake in development
 * and in every automated test so neither ever depends on outbound network
 * access (IMPLEMENTATION_PLAN.md §2.4: "No live Rspamd/ClamAV/DNS" outside
 * CI's dedicated Phase 12).
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../../platform/config.js';
import { FakeDnsLookupPort } from './fake-resolver.js';
import { createRealDnsLookupPort } from './real-resolver.js';
import type { DnsLookupPort } from './types.js';
import type { DnsLookupPortFactory } from './propagation.js';

/**
 * A bare `new FakeDnsLookupPort()` starts with nothing seeded — every
 * `resolve*` call throws `ENODATA`/`ENOTFOUND`, so every record for every
 * domain reports `'missing'`, always. That's the right neutral starting
 * point for a unit test (every DNS driver test constructs one directly and
 * seeds exactly what that test needs — the class itself stays deliberately
 * opinion-free, and this seeding never touches it), but it made the
 * *development default* the one fake in this app with no realistic
 * out-of-the-box state: `FakeBrokerClient` ships real container/image/
 * volume/log fixtures, `FakeDmsDriver` seeds real mailbox/alias fixtures,
 * `FakeTlsCertificateSource` defaults to a reachable, valid certificate —
 * `FakeDnsLookupPort` alone gave a developer (or an E2E spec) nothing to
 * look at but "missing" on every field, for any domain, forever.
 *
 * `DNS_DEMO_DOMAIN` is the same `example.com` `FakeDmsDriver` already
 * seeds mailboxes on
 * (`apps/server/src/drivers/dms/fixtures/postfix-accounts.ts`), so
 * checking DNS for a domain that visibly has real mailboxes shows a
 * coherent, working result instead of a domain that inexplicably has mail
 * but no DNS. Every value below is constructed, standard-syntax DNS
 * record content, not captured from a real docker-mailserver instance —
 * unlike `postfix-accounts.ts`'s CLI-output format, a DNS record has no
 * DMS-specific shape to capture in the first place, so "constructed
 * correctly per RFC" is the honest provenance here, the same as
 * `FakeTlsCertificateSource`'s generated self-signed certificate. The IP
 * is RFC 5737's 203.0.113.0/24 documentation range; the DKIM `p=` value is
 * an obvious placeholder string, not a real key — nothing here decodes or
 * validates it as one (`dkim-dns.ts` only checks the tag is present and
 * non-empty).
 *
 * `DNS_ALWAYS_UNKNOWN_DOMAIN` is the other half: permanently configured to
 * fail every lookup with a non-authoritative error code, so every record
 * reports `'unknown'` — the one state a bare fake can never produce by
 * itself (an *unseeded* domain reports `'missing'`, not `'unknown'`:
 * `ENODATA`/`ENOTFOUND` are authoritative negative answers —
 * `drivers/dns/errors.ts`). AGENT_BRIEF.md §4 is explicit that a resolver
 * failure must render as `Unknown`, grey, never a false `Invalid` — this
 * is what makes that claim checkable at all outside a unit test, by
 * pointing a real browser at a domain that is guaranteed, permanently, to
 * fail every check.
 */
export const DNS_DEMO_DOMAIN = 'example.com';
export const DNS_ALWAYS_UNKNOWN_DOMAIN = 'dns-timeout.test';

function seedDevelopmentDefaults(fake: FakeDnsLookupPort): FakeDnsLookupPort {
  fake
    .setRecords(DNS_DEMO_DOMAIN, {
      mx: [{ priority: 10, exchange: `mail.${DNS_DEMO_DOMAIN}` }],
      a: ['203.0.113.10'],
    })
    .setTxt(DNS_DEMO_DOMAIN, 'v=spf1 mx ~all')
    .setTxt(`_dmarc.${DNS_DEMO_DOMAIN}`, 'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com')
    .setTxt(
      `mail._domainkey.${DNS_DEMO_DOMAIN}`,
      'v=DKIM1; k=rsa; p=PLACEHOLDER_FIXTURE_KEY_NOT_A_REAL_RSA_PUBLIC_KEY',
    )
    .setPtr('203.0.113.10', `mail.${DNS_DEMO_DOMAIN}`);

  // checkFailure() runs first in every resolve* method, keyed by whatever
  // hostname that call was given — the bare domain covers MX, SPF and
  // PTR's own resolve4/resolve6 (all three query the domain itself);
  // DKIM and DMARC query their own subdomains and need their own entries.
  fake
    .setFailure(DNS_ALWAYS_UNKNOWN_DOMAIN, 'ETIMEOUT')
    .setFailure(`mail._domainkey.${DNS_ALWAYS_UNKNOWN_DOMAIN}`, 'ETIMEOUT')
    .setFailure(`_dmarc.${DNS_ALWAYS_UNKNOWN_DOMAIN}`, 'ETIMEOUT');

  return fake;
}

export function createDnsLookupPort(config: AppConfig, logger: Logger): DnsLookupPort {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;
  if (useReal) {
    logger.info('DNS resolver: RealDnsLookupPort');
    return createRealDnsLookupPort();
  }
  logger.info('DNS resolver: FakeDnsLookupPort (development mode; no outbound DNS required)');
  return seedDevelopmentDefaults(new FakeDnsLookupPort());
}

/** Same selection, but as a per-address factory for `propagation.ts` (`checkPropagation`'s first argument). */
export function createDnsLookupPortFactory(
  config: AppConfig,
  logger: Logger,
): DnsLookupPortFactory {
  const useReal = config.isProduction || config.dangerouslyUseRealDocker;
  if (useReal) {
    logger.info('DNS resolver factory: RealDnsLookupPort (per-resolver)');
    return (servers) => createRealDnsLookupPort({ servers: [servers] });
  }
  logger.info(
    'DNS resolver factory: FakeDnsLookupPort (development mode; no outbound DNS required)',
  );
  // A single shared fake for every resolver address in development — it
  // has no per-address state (`fake-resolver.ts` is domain-keyed, not
  // server-keyed), so reusing one instance is equivalent to constructing
  // a fresh one per call.
  const shared = seedDevelopmentDefaults(new FakeDnsLookupPort());
  return () => shared;
}
