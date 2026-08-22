import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../platform/db.js';
import { runMigrations, migrations } from '../../platform/migrations/index.js';
import { AppError } from '../../platform/errors.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

function setUp(): {
  db: Database;
  repository: NotificationsRepository;
  service: NotificationsService;
} {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const repository = new NotificationsRepository(db);
  return { db, repository, service: new NotificationsService(repository) };
}

describe('NotificationsService.list', () => {
  it('maps a known dedupe key to its real link, and never exposes dedupeKey itself', () => {
    const { repository, service } = setUp();
    repository.upsertActive(
      {
        dedupeKey: 'tls-cert-expiring',
        severity: 'warning',
        title: 'Cert expiring soon',
        body: null,
      },
      '2026-08-22T09:00:00.000Z',
    );

    const { notifications, unreadCount } = service.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      severity: 'warning',
      title: 'Cert expiring soon',
      link: '/security/tls',
    });
    expect(notifications[0]).not.toHaveProperty('dedupeKey');
    expect(unreadCount).toBe(1);
  });

  it('maps a source with no real page yet to a null link, never a placeholder', () => {
    const { repository, service } = setUp();
    repository.upsertActive(
      { dedupeKey: 'rspamd', severity: 'critical', title: 'Rspamd unreachable', body: null },
      '2026-08-22T09:00:00.000Z',
    );

    expect(service.list().notifications[0]?.link).toBeNull();
  });
});

describe('NotificationsService.markRead', () => {
  it('marks the row read', () => {
    const { repository, service } = setUp();
    repository.upsertActive(
      { dedupeKey: 'k', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    const id = repository.list()[0]!.id;

    service.markRead(id);

    expect(service.list().notifications[0]?.readAt).not.toBeNull();
    expect(service.list().unreadCount).toBe(0);
  });

  it('throws NOT_FOUND for an id that does not exist, rather than silently no-opping', () => {
    const { service } = setUp();
    expect(() => service.markRead('ntf_does_not_exist')).toThrow(AppError);
  });
});

describe('NotificationsService.markAllRead', () => {
  it('marks every currently-unread notification read', () => {
    const { repository, service } = setUp();
    repository.upsertActive(
      { dedupeKey: 'a', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repository.upsertActive(
      { dedupeKey: 'b', severity: 'critical', title: 'B', body: null },
      '2026-08-22T09:00:00.000Z',
    );

    service.markAllRead();

    expect(service.list().unreadCount).toBe(0);
  });
});
