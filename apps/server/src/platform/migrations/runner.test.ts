import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../db.js';
import { runMigrations, MigrationError, type Migration } from './runner.js';
import { migrations as realMigrations } from './index.js';

function tableNames(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
}

function appliedVersions(db: Database): number[] {
  return db
    .all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    .map((row) => row.version);
}

describe('runMigrations', () => {
  it('applies cleanly on an empty in-memory database, creating every ARCHITECTURE.md §7.3 table', () => {
    const db = createDatabase(':memory:');
    runMigrations(db, realMigrations);

    const tables = tableNames(db);
    for (const expected of [
      'admins',
      'sessions',
      'login_attempts',
      'audit_log',
      'jobs',
      'job_logs',
      'backups',
      'metric_samples',
      'notifications',
      'settings',
      'schema_migrations',
      // M10 addition (migration 004) — see that migration's own doc
      // comment for why it exists alongside 001's already-present `jobs`/
      // `backups` tables.
      'config_snapshots',
      // M13 addition (migration 005) — the single-row scheduled-backup policy.
      'backup_schedule',
      // M13 addition (migration 007) — the remote destination config and its pre-change snapshots.
      'backup_destination',
      'backup_destination_snapshots',
    ]) {
      expect(tables).toContain(expected);
    }
    // Migration 006 adds columns to `backups` (per-backup upload state), no new table.
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    db.close();
  });

  it('is idempotent: running it again against an already-migrated database changes nothing and does not throw', () => {
    const db = createDatabase(':memory:');
    runMigrations(db, realMigrations);
    const tablesAfterFirstRun = tableNames(db);
    const versionsAfterFirstRun = appliedVersions(db);

    expect(() => runMigrations(db, realMigrations)).not.toThrow();

    expect(tableNames(db)).toEqual(tablesAfterFirstRun);
    expect(appliedVersions(db)).toEqual(versionsAfterFirstRun);
    db.close();
  });

  it('applies only what is missing, given a database already partway migrated', () => {
    const db = createDatabase(':memory:');
    const migrationA: Migration = {
      version: 1,
      name: 'a',
      up: (d) => d.exec('CREATE TABLE a (id INTEGER PRIMARY KEY)'),
    };
    const migrationB: Migration = {
      version: 2,
      name: 'b',
      up: (d) => d.exec('CREATE TABLE b (id INTEGER PRIMARY KEY)'),
    };

    runMigrations(db, [migrationA]);
    expect(appliedVersions(db)).toEqual([1]);

    runMigrations(db, [migrationA, migrationB]);
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['a', 'b']));
    db.close();
  });

  it('refuses to start when the database is at a migration version newer than the code knows about', () => {
    const db = createDatabase(':memory:');
    const v1: Migration = {
      version: 1,
      name: 'v1',
      up: (d) => d.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)'),
    };
    const v2: Migration = {
      version: 2,
      name: 'v2',
      up: (d) => d.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY)'),
    };

    // Migrate to version 2 with "new" code...
    runMigrations(db, [v1, v2]);
    expect(appliedVersions(db)).toEqual([1, 2]);

    // ...then simulate starting up "old" code that only knows about v1.
    expect(() => runMigrations(db, [v1])).toThrow(MigrationError);

    // Refusal must not have rolled anything back or otherwise mutated state.
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['t1', 't2']));
    db.close();
  });

  it('rejects a migration list with a duplicate version number before applying anything', () => {
    const db = createDatabase(':memory:');
    const dup: Migration = { version: 1, name: 'dup-a', up: () => {} };
    const dup2: Migration = { version: 1, name: 'dup-b', up: () => {} };

    expect(() => runMigrations(db, [dup, dup2])).toThrow(MigrationError);
    // The duplicate-version guard runs before the database is touched at
    // all, so schema_migrations was never even created — not just left empty.
    expect(tableNames(db)).not.toContain('schema_migrations');
    db.close();
  });

  it('rolls back a failing migration and does not record it as applied', () => {
    const db = createDatabase(':memory:');
    const bad: Migration = {
      version: 1,
      name: 'bad',
      up: (d) => {
        d.exec('CREATE TABLE ok_table (id INTEGER PRIMARY KEY)');
        throw new Error('simulated failure mid-migration');
      },
    };

    expect(() => runMigrations(db, [bad])).toThrow('simulated failure mid-migration');
    expect(appliedVersions(db)).toEqual([]);
    expect(tableNames(db)).not.toContain('ok_table');
    db.close();
  });

  it('the audit_log table rejects UPDATE and DELETE (append-only, ARCHITECTURE.md §7.6)', () => {
    const db = createDatabase(':memory:');
    runMigrations(db, realMigrations);

    db.run(
      'INSERT INTO audit_log (id, occurred_at, actor_label, action, result) VALUES (?, ?, ?, ?, ?)',
      ['al_1', new Date().toISOString(), 'admin@example.com', 'login', 'success'],
    );

    expect(() => db.run("UPDATE audit_log SET result = 'failure' WHERE id = 'al_1'")).toThrow();
    expect(() => db.run("DELETE FROM audit_log WHERE id = 'al_1'")).toThrow();

    const row = db.get<{ result: string }>("SELECT result FROM audit_log WHERE id = 'al_1'");
    expect(row?.result).toBe('success');
    db.close();
  });
});
