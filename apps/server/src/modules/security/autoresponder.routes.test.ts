import { describe, expect, it } from 'vitest';
import { authedInject, loginAs, setUpSecurityApp } from './security-test-harness.js';

const USER = 'alice@example.com';

describe('/api/v1/security/autoresponder', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/security/autoresponder/${USER}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('reports a real, empty status (never fabricated) for a mailbox with no autoresponder configured', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/autoresponder/${USER}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toEqual({
      enabled: false,
      subject: null,
      message: null,
      startDate: null,
      endDate: null,
      unrecognisedContent: false,
    });
  });

  it('updating with a date window is audited (without the message body) and round-trips through a subsequent GET', async () => {
    const { db, app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const putResponse = await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/autoresponder/${USER}`,
      payload: {
        enabled: true,
        subject: 'Out of office',
        message: 'I am away and will respond when I return.',
        startDate: '2026-08-20',
        endDate: '2026-08-30',
      },
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json().status).toEqual({
      enabled: true,
      subject: 'Out of office',
      message: 'I am away and will respond when I return.',
      startDate: '2026-08-20',
      endDate: '2026-08-30',
      unrecognisedContent: false,
    });

    const rows = db.all<{ details: string }>(
      "SELECT details FROM audit_log WHERE action = 'autoresponder.update'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).not.toContain('I am away');

    const getResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/autoresponder/${USER}`,
    });
    expect(getResponse.json().status).toEqual(putResponse.json().status);
  });

  it('generates a script containing a correct currentdate window, visible through the Sieve script page', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/autoresponder/${USER}`,
      payload: {
        enabled: true,
        subject: 'Out of office',
        message: 'Away until 30 August.',
        startDate: '2026-08-20',
        endDate: '2026-08-30',
      },
    });

    const scriptResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}/dwg-autoresponder`,
    });
    expect(scriptResponse.statusCode).toBe(200);
    const body = scriptResponse.json();
    expect(body.active).toBe(true);
    expect(body.content).toContain('currentdate :zone "+0000" :value "ge" "date" "2026-08-20"');
    expect(body.content).toContain('currentdate :zone "+0000" :value "le" "date" "2026-08-30"');
    expect(body.content).toContain('vacation');
  });

  it('disabling preserves the draft subject/message instead of discarding it', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/autoresponder/${USER}`,
      payload: { enabled: true, subject: 'Away', message: 'Back soon.' },
    });

    const disableResponse = await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/autoresponder/${USER}`,
      payload: { enabled: false, subject: 'Away', message: 'Back soon.' },
    });
    expect(disableResponse.json().status).toEqual({
      enabled: false,
      subject: 'Away',
      message: 'Back soon.',
      startDate: null,
      endDate: null,
      unrecognisedContent: false,
    });

    // Disabling the autoresponder must not leave it as the mailbox's
    // active Sieve script.
    const scriptResponse = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/sieve/${USER}/dwg-autoresponder`,
    });
    expect(scriptResponse.json().active).toBe(false);
  });

  it('reports unrecognisedContent honestly when the reserved script name was hand-edited via the Sieve page', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/sieve/${USER}/dwg-autoresponder`,
      payload: { content: 'require ["fileinto"];\nif true {\n  fileinto "INBOX";\n}\n' },
    });

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: `/api/v1/security/autoresponder/${USER}`,
    });
    const status = response.json().status;
    expect(status.unrecognisedContent).toBe(true);
    expect(status.subject).toBeNull();
    expect(status.message).toBeNull();
  });

  it('rejects an update with a malformed date at the schema layer', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'PUT',
      url: `/api/v1/security/autoresponder/${USER}`,
      payload: { enabled: true, subject: 'Away', message: 'Back soon.', startDate: '20-08-2026' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});
