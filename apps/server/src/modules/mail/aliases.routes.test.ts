import { describe, expect, it } from 'vitest';
import type { Database } from '../../platform/db.js';
import { authedInject, loginAs, PRIMARY_EMAIL, setUpMailApp } from './mail-test-harness.js';

function auditRows(db: Database, action: string): Array<{ details: string }> {
  return db.all<{ details: string }>('SELECT details FROM audit_log WHERE action = ?', [action]);
}

describe('GET /api/v1/aliases — one page for aliases and forwarding (FEATURE_MATRIX.md §4, §5)', () => {
  it('lists every alias with a type derived from whether its recipients are local', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/aliases' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.aliases).toHaveLength(5);
    expect(body.unparseableLines).toBe(0);

    const byAddress = new Map(
      body.aliases.map((a: { address: string; type: string }) => [a.address, a.type]),
    );
    // otherdomain.tld is itself a real DMS domain (info@otherdomain.tld is
    // a mailbox), so forwarding there is "internal" even though the
    // recipient is not an alias's own domain — the classification is
    // domain-membership, not "same domain as the alias".
    expect(byAddress.get('alias2@localhost.localdomain')).toBe('internal');
    expect(byAddress.get('sales@example.com')).toBe('internal');
    // gmail.com is never a DMS domain, so this is genuinely external
    // forwarding (FEATURE_MATRIX.md §5).
    expect(byAddress.get('newsletter@example.com')).toBe('external');

    await app.close();
  });

  it('filters by domain', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/aliases?domain=example.com',
    });

    expect(response.json().aliases).toHaveLength(3);
    await app.close();
  });

  it('filters by type', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/aliases?type=external',
    });

    const aliases = response.json().aliases;
    expect(aliases).toHaveLength(1);
    expect(aliases[0].address).toBe('newsletter@example.com');
    await app.close();
  });
});

describe('POST /api/v1/aliases — create', () => {
  it('creates a new alias with multiple recipients in one call and audits it', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/aliases',
      payload: {
        alias: 'team@example.com',
        recipients: ['admin@example.com', 'user1@example.com'],
      },
    });

    expect(response.statusCode).toBe(201);
    const alias = response.json().alias;
    expect(alias.id).toBe('team@example.com');
    expect(alias.recipients.sort()).toEqual(['admin@example.com', 'user1@example.com']);
    expect(auditRows(db, 'alias.create')).toHaveLength(1);

    await app.close();
  });

  it('rejects a direct self-reference as a loop', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/aliases',
      payload: { alias: 'self@example.com', recipients: ['self@example.com'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message.toLowerCase()).toContain('loop');
  });

  it('rejects a two-hop loop across two alias entries', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const first = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/aliases',
      payload: { alias: 'loop-a@example.com', recipients: ['loop-b@example.com'] },
    });
    expect(first.statusCode).toBe(201);

    const second = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/aliases',
      payload: { alias: 'loop-b@example.com', recipients: ['loop-a@example.com'] },
    });

    expect(second.statusCode).toBe(400);
    expect(second.json().error.message.toLowerCase()).toContain('loop');

    await app.close();
  });

  it.each(['; rm -rf /', '$(id)', '`id`', 'a\nb'])(
    'rejects an injection-shaped alias address %j without a bare 500',
    async (payload) => {
      const { app } = await setUpMailApp();
      const auth = await loginAs(app);

      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/aliases',
        payload: { alias: payload, recipients: ['admin@example.com'] },
      });

      expect(response.statusCode).toBeLessThan(500);
      expect(response.json().error.code).not.toBe('INTERNAL');
      await app.close();
    },
  );
});

describe('PUT /api/v1/aliases/:id — edit = delete + re-add, presented as one call (FEATURE_MATRIX.md §4)', () => {
  it('replaces the recipient set: adds the new one, removes the dropped one, keeps the shared one', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: '/api/v1/aliases/sales@example.com',
      payload: { recipients: ['admin@example.com', 'newhire@example.com'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().alias.recipients.sort()).toEqual([
      'admin@example.com',
      'newhire@example.com',
    ]);
    expect(auditRows(db, 'alias.update')).toHaveLength(1);

    const listResponse = await authedInject(app, auth, { method: 'GET', url: '/api/v1/aliases' });
    const sales = listResponse
      .json()
      .aliases.find((a: { address: string }) => a.address === 'sales@example.com');
    expect(sales.recipients.sort()).toEqual(['admin@example.com', 'newhire@example.com']);

    await app.close();
  });

  it('returns NOT_FOUND for an alias address that does not exist', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: '/api/v1/aliases/nobody-has-this@example.com',
      payload: { recipients: ['admin@example.com'] },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/aliases/:id', () => {
  it('deletes every recipient of the alias, and it is gone from the list afterwards', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/aliases/postmaster@example.com',
    });
    expect(response.statusCode).toBe(204);
    expect(auditRows(db, 'alias.delete')).toHaveLength(1);

    const listResponse = await authedInject(app, auth, { method: 'GET', url: '/api/v1/aliases' });
    expect(
      listResponse
        .json()
        .aliases.some((a: { address: string }) => a.address === 'postmaster@example.com'),
    ).toBe(false);

    await app.close();
  });

  it('returns NOT_FOUND for an alias that does not exist', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/aliases/nobody-has-this@example.com',
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('authorization is enforced server-side on every alias route', () => {
  const mutatingRequests: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string }> = [
    { method: 'POST', url: '/api/v1/aliases' },
    { method: 'PUT', url: '/api/v1/aliases/sales@example.com' },
    { method: 'DELETE', url: '/api/v1/aliases/sales@example.com' },
  ];

  it('rejects every route with no session at all', async () => {
    const { app } = await setUpMailApp();

    for (const req of [{ method: 'GET' as const, url: '/api/v1/aliases' }, ...mutatingRequests]) {
      const response = await app.inject(req);
      expect(response.statusCode).toBe(401);
    }

    await app.close();
  });

  it('rejects every mutating route missing its CSRF token', async () => {
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
    }

    await app.close();
  });
});
