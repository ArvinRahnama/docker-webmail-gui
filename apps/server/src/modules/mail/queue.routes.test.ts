import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { authedInject, loginAs, setUpMailApp } from './mail-test-harness.js';

describe('GET /api/v1/mail/queue — read-only (UX_ARCHITECTURE.md §5.2)', () => {
  it('requires authentication', async () => {
    const { app } = await setUpMailApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/mail/queue' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('lists every queued message from the real DmsDriver.getMailQueue(), grouped by queue name', async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/mail/queue' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: Array<{ queueName: string; queueId: string; sender: string }>;
      byQueue: Record<string, number>;
      unparseableLines: number;
    };

    // FIXTURE_POSTQUEUE_JSON (drivers/dms/fixtures/postqueue.ts)
    // deliberately spans more than one queue — same fixture the fake
    // DmsDriver test already asserts against.
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.byQueue['deferred']).toBeGreaterThan(0);
    expect(body.byQueue['incoming']).toBe(0); // zero-filled, never an absent key
    expect(body.unparseableLines).toBe(0);

    await app.close();
  });

  it('surfaces a real postqueue failure as a genuine server error, never a silently-empty 200', async () => {
    const driver = Object.assign(new FakeDmsDriver(), {
      getMailQueue: async () => {
        throw new Error('postqueue: command not found');
      },
    });
    const { app } = await setUpMailApp(driver);
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/mail/queue' });
    // Unlike the dashboard's own per-tile isolation, this is the queue's
    // *own* dedicated endpoint — a genuine backend failure here is a real
    // 5xx-mapped error, surfaced honestly rather than silently emptied.
    expect(response.statusCode).toBeGreaterThanOrEqual(500);

    await app.close();
  });

  it("has no POST/PATCH/DELETE route — read-only, matching domains.routes.ts's own precedent for a resource this API cannot yet mutate", async () => {
    const { app } = await setUpMailApp();
    const auth = await loginAs(app);

    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await authedInject(app, auth, { method, url: '/api/v1/mail/queue' });
      expect(response.statusCode).toBe(404);
    }

    await app.close();
  });
});
