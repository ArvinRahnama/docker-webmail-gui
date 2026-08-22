/**
 * DNS `Unknown` state — the honesty check IMPLEMENTATION_PLAN.md §2.4's
 * "DNS check" workflow needs to actually be trustworthy. `AGENT_BRIEF.md`
 * §4 states this in the most direct terms this repository uses anywhere:
 * "`Unknown` is grey, not yellow — a resolver failure must never render as
 * `Invalid`." Nothing before this spec proved that end to end; it was a
 * documented intention, backed by unit coverage of the classification
 * function (`drivers/dns/errors.test.ts`) and the checker modules
 * (`email-auth.test.ts` et al.), but never by a real browser rendering the
 * real failure page.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts).
 *
 * Runs against `DNS_ALWAYS_UNKNOWN_DOMAIN` (`dns-timeout.test`), which
 * `create-dns-resolver.ts` permanently seeds to fail every lookup with a
 * non-authoritative error code (`ETIMEOUT`) — the one way to reach
 * `'unknown'` at all: an *unseeded* domain reports `'missing'`
 * (`ENOTFOUND`/`ENODATA` are authoritative negative answers —
 * `drivers/dns/errors.ts`), never `'unknown'`, so this state cannot be
 * reached by accident or omission. See dns-check.spec.ts for the
 * companion "a real, resolvable domain reports every record valid" case
 * this domain is deliberately the opposite of.
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

const DNS_ALWAYS_UNKNOWN_DOMAIN = 'dns-timeout.test';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('DNS check — resolver failure', () => {
  test('a resolver failure renders every record as Unknown, never Invalid/Critical', async ({
    page,
  }) => {
    await page.goto(`/security/email-auth/${DNS_ALWAYS_UNKNOWN_DOMAIN}`);
    await expect(
      page.getByRole('heading', { name: DNS_ALWAYS_UNKNOWN_DOMAIN, exact: true }),
    ).toBeVisible();

    // All five records — MX, SPF, DKIM, DMARC, PTR — fail to resolve here.
    // The status vocabulary an 'invalid' DnsRecordState renders as is
    // "Critical" (dns-record-card.tsx's DNS_STATE_TO_STATUS map), not the
    // word "Invalid" itself — asserting zero "Critical" chips is the
    // actual claim; a "Missing" reading would also be wrong here (that's
    // an authoritative negative answer, not what a timeout is).
    await expect(page.getByText('Unknown', { exact: true })).toHaveCount(5);
    await expect(page.getByText('Critical', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Missing', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Healthy', { exact: true })).toHaveCount(0);

    // The underlying error is surfaced too, not swallowed into a bare
    // status chip with no explanation of what actually went wrong.
    await expect(page.getByText(/DNS lookup failed \(ETIMEOUT\)/).first()).toBeVisible();
  });
});
