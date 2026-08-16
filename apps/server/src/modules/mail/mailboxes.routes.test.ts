import { describe, expect, it } from 'vitest';
import type { Database } from '../../platform/db.js';
import { authedInject, loginAs, PRIMARY_EMAIL, setUpMailApp } from './mail-test-harness.js';

function auditRows(db: Database, action: string): Array<{ details: string }> {
  return db.all<{ details: string }>('SELECT details FROM audit_log WHERE action = ?', [action]);
}

describe('GET /api/v1/mailboxes — list', () => {
  it('lists every mailbox with restriction status derived from the access-map fixtures', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/mailboxes' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(5);
    const byEmail = new Map(
      body.mailboxes.map((m: { email: string; restricted: unknown }) => [m.email, m.restricted]),
    );
    expect(byEmail.get('sales@example.com')).toEqual({ send: true, receive: false });
    expect(byEmail.get('admin@example.com')).toEqual({ send: false, receive: false });

    await app.close();
  });

  it('paginates server-side', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes?page=2&pageSize=2',
    });

    const body = response.json();
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(2);
    expect(body.mailboxes).toHaveLength(2);
    expect(body.total).toBe(5);

    await app.close();
  });

  it('filters by domain', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes?domain=example.com',
    });

    const body = response.json();
    expect(body.total).toBe(3);
    expect(body.mailboxes.every((m: { domain: string }) => m.domain === 'example.com')).toBe(true);

    await app.close();
  });

  it('filters by search substring', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes?search=sales',
    });

    const body = response.json();
    expect(body.mailboxes.map((m: { email: string }) => m.email)).toEqual(['sales@example.com']);

    await app.close();
  });

  it('sorts descending when asked', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes?sortBy=email&sortDir=desc',
    });

    const emails = response.json().mailboxes.map((m: { email: string }) => m.email);
    expect(emails).toEqual([...emails].sort().reverse());

    await app.close();
  });
});

describe('GET /api/v1/mailboxes/:address — detail', () => {
  it('returns the mailbox, its usage, and every alias pointing at it', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes/admin@example.com',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mailbox.email).toBe('admin@example.com');
    expect(body.usage).not.toBeNull();
    expect(body.usage.available).toBe(true);
    expect(body.dependentAliases).toHaveLength(3);

    await app.close();
  });

  it('returns NOT_FOUND for an address with no mailbox', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes/nobody@example.com',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');

    await app.close();
  });
});

describe('POST /api/v1/mailboxes — create', () => {
  it('creates a mailbox and audits it without ever writing the password', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes',
      payload: { email: 'new-user@example.com', password: 'a-perfectly-good-password-123' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().mailbox.email).toBe('new-user@example.com');
    // The response body must never carry the password either.
    expect(JSON.stringify(response.json())).not.toContain('a-perfectly-good-password-123');

    const rows = auditRows(db, 'mailbox.create');
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.details).not.toContain('a-perfectly-good-password-123');
      expect(row.details.toLowerCase()).not.toContain('password');
    }

    await app.close();
  });

  it('rejects a duplicate mailbox without a bare 500', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes',
      payload: { email: 'admin@example.com', password: 'a-perfectly-good-password-123' },
    });

    expect(response.statusCode).toBeLessThan(500);
    expect(response.json().error.code).not.toBe('INTERNAL');
  });

  it.each(['; rm -rf /', '$(id)', '`id`', 'a\nb', '-leadinghyphen'])(
    'rejects an injection-shaped email %j reaching the command builder, never a bare 500',
    async (payload) => {
      const { app } = await setUpMailApp();
      const auth = await loginAs(app);

      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/mailboxes',
        payload: { email: payload, password: 'a-perfectly-good-password-123' },
      });

      expect(response.statusCode).toBeLessThan(500);
      expect(response.json().error.code).not.toBe('INTERNAL');
      await app.close();
    },
  );
});

describe('PATCH /api/v1/mailboxes/:address/password', () => {
  it('changes the password and never returns or audits it', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PATCH',
      url: '/api/v1/mailboxes/admin@example.com/password',
      payload: { password: 'a-brand-new-password-value-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ changed: true });

    const rows = auditRows(db, 'mailbox.password_change');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).not.toContain('a-brand-new-password-value-1');
    expect(rows[0]?.details.toLowerCase()).not.toContain('password_hash');

    await app.close();
  });

  it('returns NOT_FOUND for a mailbox that does not exist', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PATCH',
      url: '/api/v1/mailboxes/nobody@example.com/password',
      payload: { password: 'a-brand-new-password-value-1' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/v1/mailboxes/:address/restrict', () => {
  it('adds and then removes a send restriction, auditing both', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const addResponse = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/admin@example.com/restrict',
      payload: { scope: 'send', restricted: true },
    });
    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json().mailbox.restricted).toEqual({ send: true, receive: false });

    const removeResponse = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/admin@example.com/restrict',
      payload: { scope: 'send', restricted: false },
    });
    expect(removeResponse.json().mailbox.restricted).toEqual({ send: false, receive: false });

    expect(auditRows(db, 'mailbox.restrict')).toHaveLength(2);

    await app.close();
  });

  it('rejects a scope outside send/receive', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/admin@example.com/restrict',
      payload: { scope: 'login', restricted: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('mailbox quota — PUT/DELETE /api/v1/mailboxes/:address/quota', () => {
  it('sets and clears a quota, auditing both', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const setResponse = await authedInject(app, auth, {
      method: 'PUT',
      url: '/api/v1/mailboxes/user1@example.com/quota',
      payload: { quota: '750M' },
    });
    expect(setResponse.statusCode).toBe(200);
    expect(setResponse.json().mailbox.quota).toBe('750M');

    const clearResponse = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/mailboxes/user1@example.com/quota',
    });
    expect(clearResponse.json().mailbox.quota).toBeNull();

    expect(auditRows(db, 'mailbox.quota_set')).toHaveLength(1);
    expect(auditRows(db, 'mailbox.quota_clear')).toHaveLength(1);

    await app.close();
  });

  it.each(['; rm -rf /', '10M; rm', 'unlimited', ''])(
    'rejects an invalid quota value %j',
    async (quota) => {
      const { app } = await setUpMailApp();
      const auth = await loginAs(app);

      const response = await authedInject(app, auth, {
        method: 'PUT',
        url: '/api/v1/mailboxes/user1@example.com/quota',
        payload: { quota },
      });

      expect(response.statusCode).toBe(400);
      await app.close();
    },
  );
});

describe('DELETE /api/v1/mailboxes/:address — Tier 3, explicit mailData required', () => {
  it('rejects a delete with no mailData choice at all', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/mailboxes/admin@example.com',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('deletes the mailbox, audits the dependent-alias count, and the mailbox is gone afterwards', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const deleteResponse = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/mailboxes/admin@example.com',
      payload: { mailData: 'keep' },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const followUp = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/mailboxes/admin@example.com',
    });
    expect(followUp.statusCode).toBe(404);

    const rows = auditRows(db, 'mailbox.delete');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.details)).toMatchObject({
      email: 'admin@example.com',
      mailData: 'keep',
      dependentAliasCount: 3,
    });

    await app.close();
  });
});

describe('bulk mailbox operations — restrict and quota only, no bulk delete route exists', () => {
  it('bulk-restricts several addresses in one call and audits once', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/bulk-restrict',
      payload: {
        addresses: ['admin@example.com', 'user1@example.com'],
        scope: 'receive',
        restricted: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const results: Array<{ email: string; ok: boolean }> = response.json().results;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(auditRows(db, 'mailbox.bulk_restrict')).toHaveLength(1);

    await app.close();
  });

  it('bulk-clears quota for several addresses', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/bulk-quota',
      payload: { addresses: ['admin@example.com', 'user1@example.com'], quota: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results.every((r: { ok: boolean }) => r.ok)).toBe(true);

    await app.close();
  });

  it('an address that is email-shaped enough to pass request validation but rejected by the command builder (leading "-") fails only that one item — a bulk batch is never all-or-nothing', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/bulk-restrict',
      payload: {
        addresses: ['admin@example.com', '-leading@example.com', 'user1@example.com'],
        scope: 'send',
        restricted: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const results: Array<{ email: string; ok: boolean; error: string | null }> =
      response.json().results;
    expect(results).toHaveLength(3);
    const byEmail = new Map(results.map((r) => [r.email, r]));
    expect(byEmail.get('admin@example.com')?.ok).toBe(true);
    expect(byEmail.get('user1@example.com')?.ok).toBe(true);
    expect(byEmail.get('-leading@example.com')?.ok).toBe(false);
    expect(byEmail.get('-leading@example.com')?.error).toBeTruthy();

    await app.close();
  });

  it('there is no bulk-delete route', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/mailboxes/bulk-delete',
      payload: { addresses: ['admin@example.com'] },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('authorization is enforced server-side on every mailbox route', () => {
  const mutatingRequests: Array<{ method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string }> = [
    { method: 'POST', url: '/api/v1/mailboxes' },
    { method: 'PATCH', url: '/api/v1/mailboxes/admin@example.com/password' },
    { method: 'POST', url: '/api/v1/mailboxes/admin@example.com/restrict' },
    { method: 'PUT', url: '/api/v1/mailboxes/admin@example.com/quota' },
    { method: 'DELETE', url: '/api/v1/mailboxes/admin@example.com/quota' },
    { method: 'DELETE', url: '/api/v1/mailboxes/admin@example.com' },
    { method: 'POST', url: '/api/v1/mailboxes/bulk-restrict' },
    { method: 'POST', url: '/api/v1/mailboxes/bulk-quota' },
  ];

  it('rejects every route (read and write) with no session at all', async () => {
    const { app } = await setUpMailApp();

    const allRequests = [{ method: 'GET' as const, url: '/api/v1/mailboxes' }, ...mutatingRequests];
    for (const req of allRequests) {
      const response = await app.inject(req);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }

    await app.close();
  });

  it('rejects every mutating route missing its CSRF token even with a valid session', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    for (const req of mutatingRequests) {
      const response = await app.inject({
        method: req.method,
        url: req.url,
        cookies: { dwg_session: auth.token },
        headers: { 'sec-fetch-site': 'same-origin' },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    }

    await app.close();
  });

  it('rejects every route for a session whose role carries no mail:manage permission', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);
    db.run('UPDATE admins SET role = ? WHERE email = ?', ['guest', PRIMARY_EMAIL]);

    for (const req of mutatingRequests) {
      const response = await authedInject(app, auth, { ...req, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    }

    await app.close();
  });
});
