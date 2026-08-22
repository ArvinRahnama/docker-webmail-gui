/**
 * DNS check — an M8 exit criterion (IMPLEMENTATION_PLAN.md §3) and one of
 * the twelve critical workflows §2.4 lists.
 *
 * Starts already authenticated via the shared fixture session
 * (`AUTH_STATE_PATH` — see playwright.config.ts and global-setup.ts).
 *
 * Runs against `DNS_DEMO_DOMAIN` (`example.com`), which
 * `create-dns-resolver.ts` now seeds with a full, resolvable MX/SPF/DKIM/
 * DMARC/PTR chain specifically so this workflow has something real to
 * check against — a bare `FakeDnsLookupPort` reports every record
 * `'missing'` for every domain, always (see that file's own doc comment).
 * That seeding is itself a real backend behaviour, not a hardcoded UI
 * fixture: this spec is what proves the report the page renders actually
 * came from a live `GET /api/v1/security/dns/:domain` round trip against
 * `FakeDnsLookupPort`, not a static client-side placeholder — the
 * companion dns-unknown-state.spec.ts proves the same page renders a
 * completely different (grey Unknown, not red Critical) result for a
 * domain seeded to fail instead. Never real DNS: APP_MODE stays
 * "development" and DANGEROUSLY_USE_REAL_DOCKER is never set anywhere in
 * this harness (playwright.config.ts), which is what selects the fake in
 * the first place (create-dns-resolver.ts).
 */
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

const DNS_DEMO_DOMAIN = 'example.com';

test.use({ storageState: AUTH_STATE_PATH });

test.describe('DNS check', () => {
  test('checks a real domain and reports every record valid, sourced from the live backend', async ({
    page,
  }) => {
    await page.goto(`/security/email-auth/${DNS_DEMO_DOMAIN}`);
    await expect(page.getByRole('heading', { name: DNS_DEMO_DOMAIN, exact: true })).toBeVisible();

    // All five records — MX, SPF, DKIM, DMARC, PTR — are seeded valid.
    // Counting the status chips (rather than scoping into each card
    // individually) is what actually proves *every* record came back
    // valid, not just that the word "Healthy" appears somewhere.
    await expect(page.getByText('Healthy', { exact: true })).toHaveCount(5);
    await expect(page.getByText('Critical', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Unknown', { exact: true })).toHaveCount(0);

    // The actual record values, not just the status colour — proof this
    // is create-dns-resolver.ts's seeded content specifically, not any
    // valid-looking placeholder.
    await expect(page.getByText('10 mail.example.com')).toBeVisible();
    await expect(page.getByText('v=spf1 mx ~all')).toBeVisible();
    await expect(page.getByText(/v=DKIM1.*p=PLACEHOLDER_FIXTURE_KEY/)).toBeVisible();
    await expect(page.getByText(/v=DMARC1.*p=quarantine/)).toBeVisible();
    await expect(page.getByText('203.0.113.10 → mail.example.com')).toBeVisible();

    // The "Re-check" action re-fetches rather than only ever showing the
    // first response.
    await page.getByRole('button', { name: 'Re-check' }).click();
    await expect(page.getByText('Healthy', { exact: true })).toHaveCount(5);
  });
});
