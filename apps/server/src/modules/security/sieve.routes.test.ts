import { describe, expect, it } from 'vitest';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

const USER = 'alice@example.com';
const VALID_SCRIPT = 'require ["fileinto"];\nif true {\n  fileinto "INBOX";\n}\n';

describe('/api/v1/security/sieve', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists no scripts for a mailbox that has none yet', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().scripts).toEqual([]);
  });

  it('storing a script is audited and then listed/readable back', async () => {
    const { db, app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const putResponse = await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/myfilter`,
      payload: { content: VALID_SCRIPT },
    });
    expect(putResponse.statusCode).toBe(200);

    const rows = db.all("SELECT * FROM audit_log WHERE action = 'sieve.script_update'");
    expect(rows).toHaveLength(1);

    const listResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}`,
    });
    expect(listResponse.json().scripts).toEqual([{ name: 'myfilter', active: false }]);

    const getResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}/myfilter`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual({ name: 'myfilter', content: VALID_SCRIPT, active: false });
  });

  it('rejects a script referencing vnd.dovecot.execute before it is ever stored', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/dangerous`,
      payload: { content: 'require ["vnd.dovecot.execute"];\nexecute :pipe "cmd";' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');

    const listResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}`,
    });
    expect(listResponse.json().scripts).toEqual([]);
  });

  it('rejects a script referencing sieve_pipe before it is ever stored', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/dangerous`,
      payload: { content: 'require ["vnd.dovecot.pipe"];\nsieve_pipe :bin "x" "y";' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('activating a script is audited and deactivates whatever was previously active', async () => {
    const { db, app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/first`,
      payload: { content: VALID_SCRIPT },
    });
    await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/second`,
      payload: { content: VALID_SCRIPT },
    });

    await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/security/sieve/${USER}/first/activate`,
    });
    const activateSecond = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/security/sieve/${USER}/second/activate`,
    });
    expect(activateSecond.statusCode).toBe(200);

    const rows = db.all("SELECT * FROM audit_log WHERE action = 'sieve.script_activate'");
    expect(rows).toHaveLength(2);

    const listResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}`,
    });
    expect(listResponse.json().scripts).toEqual(
      expect.arrayContaining([
        { name: 'first', active: false },
        { name: 'second', active: true },
      ]),
    );
  });

  it('deactivating is audited and clears the active flag', async () => {
    const { db, app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/myfilter`,
      payload: { content: VALID_SCRIPT },
    });
    await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/security/sieve/${USER}/myfilter/activate`,
    });

    const deactivateResponse = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/security/sieve/${USER}/deactivate`,
    });
    expect(deactivateResponse.statusCode).toBe(200);

    const rows = db.all("SELECT * FROM audit_log WHERE action = 'sieve.script_deactivate'");
    expect(rows).toHaveLength(1);

    const listResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}`,
    });
    expect(listResponse.json().scripts).toEqual([{ name: 'myfilter', active: false }]);
  });

  it('returns NOT_FOUND for a script that does not exist', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}/does-not-exist`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects an oversized script before it is ever stored', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/huge`,
      payload: { content: 'a'.repeat(100_001) },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});
