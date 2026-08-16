import { describe, expect, it } from 'vitest';
import { authedInject, loginAs, PRIMARY_EMAIL, setUpMailApp } from './mail-test-harness.js';

describe('GET /api/v1/domains — derived, read-only list', () => {
  it('lists every domain derived from accounts and aliases, including alias-only domains', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/domains' });

    expect(response.statusCode).toBe(200);
    const domains: Array<{
      domain: string;
      mailboxCount: number;
      aliasCount: number;
      aliasOnly: boolean;
    }> = response.json().domains;
    const byName = new Map(domains.map((d) => [d.domain, d]));

    expect([...byName.keys()].sort()).toEqual([
      'catchall.example.com',
      'domainone.tld',
      'example.com',
      'localhost.localdomain',
      'otherdomain.tld',
    ]);

    // FEATURE_MATRIX.md §2: an alias-only domain must be represented and
    // flagged, not folded into "not a real domain".
    expect(byName.get('catchall.example.com')).toMatchObject({ mailboxCount: 0, aliasOnly: true });
    expect(byName.get('localhost.localdomain')).toMatchObject({ mailboxCount: 0, aliasOnly: true });
    expect(byName.get('example.com')).toMatchObject({
      mailboxCount: 3,
      aliasCount: 3,
      aliasOnly: false,
    });

    await app.close();
  });
});

describe('GET /api/v1/domains/:domain — detail', () => {
  it('returns the domain plus every mailbox and alias that belongs to it', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/domains/example.com',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.domain.domain).toBe('example.com');
    expect(body.mailboxes).toHaveLength(3);
    expect(body.aliases).toHaveLength(3);
    expect(body.mailboxes.map((m: { email: string }) => m.email).sort()).toEqual([
      'admin@example.com',
      'sales@example.com',
      'user1@example.com',
    ]);

    await app.close();
  });

  it("returns a real alias-only domain's detail with zero mailboxes", async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/domains/catchall.example.com',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.domain.aliasOnly).toBe(true);
    expect(body.mailboxes).toEqual([]);
    expect(body.aliases).toHaveLength(1);

    await app.close();
  });

  it('returns NOT_FOUND for a domain nothing references', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/domains/never-heard-of-it.tld',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');

    await app.close();
  });
});

describe('no create/delete/enable domain route exists (FEATURE_MATRIX.md §2)', () => {
  it('POST /api/v1/domains is not a route', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/domains',
      payload: { domain: 'new-domain.tld' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('PATCH /api/v1/domains/:domain is not a route', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PATCH',
      url: '/api/v1/domains/example.com',
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('DELETE /api/v1/domains/:domain is not a route', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/domains/example.com',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});

describe('authorization is enforced server-side on every route', () => {
  it('rejects both routes with no session at all', async () => {
    const { app } = await setUpMailApp();

    for (const url of ['/api/v1/domains', '/api/v1/domains/example.com']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }

    await app.close();
  });

  it('rejects both routes for a session whose stored role carries no mail:manage permission', async () => {
    const { app, db } = await setUpMailApp();
    const auth = await loginAs(app);
    db.run('UPDATE admins SET role = ? WHERE email = ?', ['guest', PRIMARY_EMAIL]);

    for (const url of ['/api/v1/domains', '/api/v1/domains/example.com']) {
      const response = await authedInject(app, auth, { method: 'GET', url });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    }

    await app.close();
  });
});
