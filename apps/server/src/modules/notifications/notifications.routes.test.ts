/**
 * HTTP-level coverage for `/api/v1/notifications/*`. Seeds state directly
 * through a second `NotificationsRepository` instance bound to the same
 * `db` the harness returns — the same table `app.ts`'s own instance
 * reads and writes, so this is exactly equivalent to a real evaluator
 * tick having run, without this suite depending on the periodic
 * evaluator's real timer (which `notifications-evaluator.test.ts` already
 * covers directly, with no timing dependency of its own either).
 */
import { describe, expect, it } from 'vitest';
import type { NotificationListResponse } from '@dwg/shared';
import { NotificationsRepository } from './notifications.repository.js';
import { authedInject, loginAs, setUpDashboardApp } from '../dashboard/dashboard-test-harness.js';

describe('/api/v1/notifications', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDashboardApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('starts empty on a fresh install', async () => {
    const { app } = await setUpDashboardApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/notifications' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as NotificationListResponse;
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
    await app.close();
  });

  it('lists a real notification with its severity, title and a real link — never the internal dedupe key', async () => {
    const { app, db } = await setUpDashboardApp();
    new NotificationsRepository(db).upsertActive(
      {
        dedupeKey: 'broker',
        severity: 'critical',
        title: 'Broker connectivity',
        body: 'ping failed',
      },
      '2026-08-22T09:00:00.000Z',
    );
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, { method: 'GET', url: '/api/v1/notifications' });
    const body = response.json() as NotificationListResponse;
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      severity: 'critical',
      title: 'Broker connectivity',
      body: 'ping failed',
      link: '/docker/health',
    });
    expect(body.notifications[0]).not.toHaveProperty('dedupeKey');
    expect(body.unreadCount).toBe(1);

    await app.close();
  });

  it('POST /:id/read marks one notification read (dismiss) without resolving the underlying condition', async () => {
    const { app, db } = await setUpDashboardApp();
    const repository = new NotificationsRepository(db);
    repository.upsertActive(
      { dedupeKey: 'broker', severity: 'critical', title: 'Broker connectivity', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    const id = repository.list()[0]!.id;
    const auth = await loginAs(app);

    const readResponse = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/notifications/${id}/read`,
    });
    expect(readResponse.statusCode).toBe(200);

    const after = (
      (
        await authedInject(app, auth, { method: 'GET', url: '/api/v1/notifications' })
      ).json() as NotificationListResponse
    ).notifications[0]!;
    expect(after.readAt).not.toBeNull();
    // Still active — dismissing an admin's *view* of a problem does not
    // make the broker start responding again (notifications.ts's own
    // "dismiss marks read, never resolves" rule).
    expect(after.resolvedAt).toBeNull();

    await app.close();
  });

  it('POST /:id/read on an unknown id fails rather than silently succeeding', async () => {
    const { app } = await setUpDashboardApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/notifications/ntf_does_not_exist/read',
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('POST /read-all clears unreadCount for every currently-unread notification', async () => {
    const { app, db } = await setUpDashboardApp();
    const repository = new NotificationsRepository(db);
    repository.upsertActive(
      { dedupeKey: 'broker', severity: 'critical', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repository.upsertActive(
      { dedupeKey: 'clamav', severity: 'critical', title: 'B', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    const auth = await loginAs(app);

    expect(
      (
        (
          await authedInject(app, auth, { method: 'GET', url: '/api/v1/notifications' })
        ).json() as NotificationListResponse
      ).unreadCount,
    ).toBe(2);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/notifications/read-all',
    });
    expect(response.statusCode).toBe(200);

    expect(
      (
        (
          await authedInject(app, auth, { method: 'GET', url: '/api/v1/notifications' })
        ).json() as NotificationListResponse
      ).unreadCount,
    ).toBe(0);

    await app.close();
  });
});
