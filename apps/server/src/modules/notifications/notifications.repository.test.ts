import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../platform/db.js';
import { runMigrations, migrations } from '../../platform/migrations/index.js';
import { NotificationsRepository } from './notifications.repository.js';

function setUpDb(): Database {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  return db;
}

describe('NotificationsRepository.upsertActive', () => {
  it('inserts a new row the first time a dedupe key is seen', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);

    repo.upsertActive(
      { dedupeKey: 'tls-cert-expiring', severity: 'warning', title: 'Cert expiring', body: null },
      '2026-08-22T09:00:00.000Z',
    );

    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: 'tls-cert-expiring',
      severity: 'warning',
      title: 'Cert expiring',
      createdAt: '2026-08-22T09:00:00.000Z',
      readAt: null,
      resolvedAt: null,
    });
    db.close();
  });

  it('is a genuine upsert: the same dedupe key never produces a second row', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);

    repo.upsertActive(
      { dedupeKey: 'k', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repo.upsertActive(
      { dedupeKey: 'k', severity: 'critical', title: 'B', body: 'now worse' },
      '2026-08-22T10:00:00.000Z',
    );

    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical', title: 'B', body: 'now worse' });
    db.close();
  });

  it('does not reset created_at or read_at while a condition is merely still active on a later tick', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);

    repo.upsertActive(
      { dedupeKey: 'k', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    const id = repo.list()[0]!.id;
    repo.markRead(id, '2026-08-22T09:30:00.000Z');

    // Re-detected on a later tick, still active.
    repo.upsertActive(
      { dedupeKey: 'k', severity: 'warning', title: 'A', body: null },
      '2026-08-22T11:00:00.000Z',
    );

    const row = repo.getById(id)!;
    expect(row.createdAt).toBe('2026-08-22T09:00:00.000Z');
    expect(row.readAt).toBe('2026-08-22T09:30:00.000Z');
    db.close();
  });

  it('resets created_at and read_at when a resolved condition recurs', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);

    repo.upsertActive(
      { dedupeKey: 'k', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    const id = repo.list()[0]!.id;
    repo.markRead(id, '2026-08-22T09:30:00.000Z');
    repo.resolveIfActive('k', '2026-08-22T10:00:00.000Z');
    expect(repo.getById(id)!.resolvedAt).toBe('2026-08-22T10:00:00.000Z');

    // The same problem comes back later.
    repo.upsertActive(
      { dedupeKey: 'k', severity: 'critical', title: 'A again', body: null },
      '2026-08-22T15:00:00.000Z',
    );

    const row = repo.getById(id)!;
    expect(row.resolvedAt).toBeNull();
    expect(row.createdAt).toBe('2026-08-22T15:00:00.000Z');
    expect(row.readAt).toBeNull();
    db.close();
  });
});

describe('NotificationsRepository.resolveIfActive', () => {
  it('is a no-op for a dedupe key with no row, and for one already resolved', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);

    expect(() => repo.resolveIfActive('never-existed', '2026-08-22T09:00:00.000Z')).not.toThrow();

    repo.upsertActive(
      { dedupeKey: 'k', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repo.resolveIfActive('k', '2026-08-22T10:00:00.000Z');
    repo.resolveIfActive('k', '2026-08-22T11:00:00.000Z'); // second call must not overwrite the first resolution time
    expect(repo.getById(repo.list()[0]!.id)!.resolvedAt).toBe('2026-08-22T10:00:00.000Z');
    db.close();
  });
});

describe('NotificationsRepository — reading', () => {
  it('countUnread counts only active AND unread rows', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);

    repo.upsertActive(
      { dedupeKey: 'a', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repo.upsertActive(
      { dedupeKey: 'b', severity: 'critical', title: 'B', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repo.upsertActive(
      { dedupeKey: 'c', severity: 'info', title: 'C', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    expect(repo.countUnread()).toBe(3);

    const bId = repo.list().find((row) => row.dedupeKey === 'b')!.id;
    repo.markRead(bId, '2026-08-22T09:05:00.000Z');
    expect(repo.countUnread()).toBe(2);

    repo.resolveIfActive('c', '2026-08-22T09:10:00.000Z');
    expect(repo.countUnread()).toBe(1);

    db.close();
  });

  it('markRead is idempotent: a second call never overwrites the first read time', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);
    repo.upsertActive(
      { dedupeKey: 'a', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    const id = repo.list()[0]!.id;

    repo.markRead(id, '2026-08-22T09:05:00.000Z');
    repo.markRead(id, '2026-08-22T09:10:00.000Z');

    expect(repo.getById(id)!.readAt).toBe('2026-08-22T09:05:00.000Z');
    db.close();
  });

  it('markAllRead marks every currently-unread row and leaves already-read ones untouched', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);
    repo.upsertActive(
      { dedupeKey: 'a', severity: 'warning', title: 'A', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repo.upsertActive(
      { dedupeKey: 'b', severity: 'warning', title: 'B', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    const aId = repo.list().find((row) => row.dedupeKey === 'a')!.id;
    repo.markRead(aId, '2026-08-22T09:01:00.000Z');

    repo.markAllRead('2026-08-22T12:00:00.000Z');

    expect(repo.getById(aId)!.readAt).toBe('2026-08-22T09:01:00.000Z'); // untouched
    const bId = repo.list().find((row) => row.dedupeKey === 'b')!.id;
    expect(repo.getById(bId)!.readAt).toBe('2026-08-22T12:00:00.000Z');
    db.close();
  });

  it('list orders active problems before resolved ones, regardless of age', () => {
    const db = setUpDb();
    const repo = new NotificationsRepository(db);
    repo.upsertActive(
      { dedupeKey: 'old-but-active', severity: 'warning', title: 'Old', body: null },
      '2026-08-01T09:00:00.000Z',
    );
    repo.upsertActive(
      { dedupeKey: 'new-but-resolved', severity: 'warning', title: 'New', body: null },
      '2026-08-22T09:00:00.000Z',
    );
    repo.resolveIfActive('new-but-resolved', '2026-08-22T10:00:00.000Z');

    const rows = repo.list();
    expect(rows.map((r) => r.dedupeKey)).toEqual(['old-but-active', 'new-but-resolved']);
    db.close();
  });
});
