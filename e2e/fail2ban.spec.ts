import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH } from './env.js';

test.use({ storageState: AUTH_STATE_PATH });

test.beforeEach(async ({ page }) => {
  const banned = new Set(['192.0.2.10', '203.0.113.12']);
  const allowed = new Set(['192.0.2.25', '2001:db8::abcd:ef01:2345:6789']);
  await page.route('**/api/v1/security/fail2ban', (route) =>
    route.fulfill({
      json: {
        capability: { supported: true, reason: null },
        bannedIps: [...banned],
        rawStatus: 'Jail list: postfix, dovecot',
      },
    }),
  );
  await page.route('**/api/v1/security/fail2ban/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.split('/').at(-1);
    if (action === 'allowlist') {
      await route.fulfill({ json: [...allowed] });
      return;
    }
    const { ip } = route.request().postDataJSON() as { ip: string };
    if (action === 'ban') banned.add(ip);
    if (action === 'unban') banned.delete(ip);
    if (action === 'add') {
      allowed.add(ip);
      banned.delete(ip);
    }
    if (action === 'remove') allowed.delete(ip);
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/security/fail2ban');
});

test('filters both lists and confirms changes to bans and exceptions', async ({ page }) => {
  const bans = page.getByRole('region', { name: 'Banned IPs', exact: true });
  const allowlist = page.getByRole('region', { name: 'Postfix allowlist', exact: true });
  await expect(bans.getByText('203.0.113.12', { exact: true })).toBeVisible();
  await expect(allowlist.getByText('192.0.2.25', { exact: true })).toBeVisible();

  const filter = page.getByRole('searchbox', { name: 'Filter IP addresses' });
  await filter.fill('192.0.2');
  await expect(bans.getByText('192.0.2.10', { exact: true })).toBeVisible();
  await expect(bans.getByText('203.0.113.12', { exact: true })).toHaveCount(0);
  await expect(allowlist.getByText('192.0.2.25', { exact: true })).toBeVisible();
  await expect(allowlist.getByText('2001:db8::abcd:ef01:2345:6789', { exact: true })).toHaveCount(
    0,
  );
  await filter.clear();

  const allowInput = page.getByLabel('IP address to allow');
  await allowInput.fill('invalid-ip');
  await allowInput.press('Enter');
  await expect(allowlist.getByRole('alert')).toHaveText('Enter a valid IPv4 or IPv6 address.');
  await allowInput.fill('192.0.2.10');
  await allowInput.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading')).toHaveText('Allow 192.0.2.10?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(bans.getByText('192.0.2.10', { exact: true })).toBeVisible();
  await allowlist.getByRole('button', { name: 'Allow IP' }).click();
  await dialog.getByRole('button', { name: 'Allow IP' }).click();
  await expect(allowlist.getByText('192.0.2.10', { exact: true })).toBeVisible();
  await expect(bans.getByText('192.0.2.10', { exact: true })).toHaveCount(0);

  await allowlist.getByRole('button', { name: 'Remove 192.0.2.10 from allowlist' }).click();
  await dialog.getByRole('button', { name: 'Remove exception' }).click();
  await expect(allowlist.getByText('192.0.2.10', { exact: true })).toHaveCount(0);

  await page.getByLabel('IP address to ban').fill('192.0.2.10');
  await bans.getByRole('button', { name: 'Ban IP', exact: true }).click();
  await dialog.getByRole('button', { name: 'Ban IP', exact: true }).click();
  await expect(bans.getByText('192.0.2.10', { exact: true })).toBeVisible();

  await bans.getByRole('button', { name: 'Unban 192.0.2.10' }).click();
  await dialog.getByRole('button', { name: 'Unban IP', exact: true }).click();
  await expect(bans.getByText('192.0.2.10', { exact: true })).toHaveCount(0);
});

test('keeps IPv6 rows in view and diagnostics collapsed on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const ipv6 = page.getByText('2001:db8::abcd:ef01:2345:6789', { exact: true });
  await expect(ipv6).toBeVisible();
  await expect(page.getByText('Jail list: postfix, dovecot', { exact: true })).toBeHidden();
  await page.getByText('Jail diagnostics', { exact: true }).click();
  await expect(page.getByText('Jail list: postfix, dovecot', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
