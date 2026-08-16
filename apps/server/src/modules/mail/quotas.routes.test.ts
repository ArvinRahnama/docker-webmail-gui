import { describe, expect, it } from 'vitest';
import { authedInject, loginAs, PRIMARY_EMAIL, setUpMailApp } from './mail-test-harness.js';

describe('GET /api/v1/quotas — Storage report (read-only, UX_ARCHITECTURE.md §5.1 row 5)', () => {
  it('reports every configured quota, joined with usage where a matching mailbox exists', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/quotas' });

    expect(response.statusCode).toBe(200);
    const entries: Array<{
      email: string;
      quota: string;
      usage: { available: boolean } | null;
      percentUsed: number | null;
    }> = response.json().entries;
    expect(entries).toHaveLength(3);

    const byEmail = new Map(entries.map((e) => [e.email, e]));
    // "user@domain" (the fixture's confirmed-upstream quota line) has no
    // matching mailbox account in postfix-accounts.cf's fixture — usage
    // must be honestly unavailable, never a fabricated number.
    expect(byEmail.get('user@domain')?.usage?.available).toBe(false);
    expect(byEmail.get('user@domain')?.percentUsed).toBeNull();
    expect(byEmail.get('admin@example.com')?.usage?.available).toBe(true);
    expect(byEmail.get('admin@example.com')?.quota).toBe('2G');

    await app.close();
  });

  it('sorts unknown/unavailable usage last, never mixed in with real percentages', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/quotas' });
    const entries: Array<{ email: string; percentUsed: number | null }> = response.json().entries;

    const nullIndex = entries.findIndex((e) => e.percentUsed === null);
    expect(nullIndex).toBe(entries.length - 1);

    await app.close();
  });

  it('there is no mutating route under /api/v1/quotas — edits happen on the mailbox', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await authedInject(app, auth, {
        method,
        url: '/api/v1/quotas',
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }

    await app.close();
  });
});

describe('authorization is enforced server-side', () => {
  it('rejects the report with no session at all', async () => {
    const { app } = await setUpMailApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/quotas' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects the report for a session whose role carries no mail:manage permission', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);
    db.run('UPDATE admins SET role = ? WHERE email = ?', ['guest', PRIMARY_EMAIL]);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/quotas' });
    expect(response.statusCode).toBe(403);

    await app.close();
  });
});
