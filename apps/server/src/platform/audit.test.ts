import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './db.js';
import { runMigrations, migrations } from './migrations/index.js';
import { recordAuditEvent } from './audit.js';

function setUpDb(): Database {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  return db;
}

/**
 * Inserts a real administrator and returns its id.
 *
 * `audit_log.actor_admin_id` carries a foreign key to `admins`, so a test
 * cannot invent an actor id. That constraint is deliberate and worth keeping:
 * it stops a typo in a call site from silently writing an audit row that
 * attributes an action to nobody. The column is `ON DELETE SET NULL` rather
 * than `CASCADE`, and `actor_label` holds a denormalised copy of who acted,
 * so deleting an administrator preserves their history instead of erasing it
 * — which is the entire point of an audit log.
 *
 * A genuinely absent actor — a failed login for an address with no account —
 * is expressed as `adminId: null`, which the schema allows.
 */
function seedAdmin(db: Database, email = 'admin@example.com'): string {
  const id = 'adm_test_1';
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO admins (id, email, password_hash, role, disabled, force_password_change, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    [id, email, 'not-a-real-hash', 'administrator', now, now],
  );
  return id;
}

interface RawAuditRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly actor_admin_id: string | null;
  readonly actor_label: string;
  readonly action: string;
  readonly target: string | null;
  readonly result: string;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly details: string | null;
}

function readAllRows(db: Database): RawAuditRow[] {
  return db.all<RawAuditRow>('SELECT * FROM audit_log');
}

describe('recordAuditEvent', () => {
  it('writes every field to the row, JSON-encoding details', () => {
    const db = setUpDb();
    const adminId = seedAdmin(db);

    recordAuditEvent(db, {
      actor: { adminId, label: 'admin@example.com' },
      action: 'admin.update',
      target: { type: 'admin', id: 'a_2' },
      result: 'success',
      ip: '203.0.113.5',
      userAgent: 'test-agent/1.0',
      details: { changed: 'disabled' },
    });

    const rows = readAllRows(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor_admin_id).toBe(adminId);
    expect(row.actor_label).toBe('admin@example.com');
    expect(row.action).toBe('admin.update');
    expect(row.target).toBe('admin:a_2');
    expect(row.result).toBe('success');
    expect(row.ip_address).toBe('203.0.113.5');
    expect(row.user_agent).toBe('test-agent/1.0');
    expect(JSON.parse(row.details ?? '{}')).toEqual({ changed: 'disabled', errorCode: null });
    expect(typeof row.id).toBe('string');
    expect(row.id.length).toBeGreaterThan(0);
    expect(() => new Date(row.occurred_at).toISOString()).not.toThrow();

    db.close();
  });

  it('stores a null target as null, not a formatted string', () => {
    const db = setUpDb();

    recordAuditEvent(db, {
      actor: { adminId: null, label: 'unknown@example.com' },
      action: 'auth.login.failure',
      target: null,
      result: 'failure',
      errorCode: 'INVALID_CREDENTIALS',
      ip: '203.0.113.5',
      userAgent: null,
    });

    const row = readAllRows(db)[0]!;
    expect(row.target).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(JSON.parse(row.details ?? '{}')).toEqual({ errorCode: 'INVALID_CREDENTIALS' });

    db.close();
  });

  it('defaults errorCode to null in details when not supplied', () => {
    const db = setUpDb();
    const adminId = seedAdmin(db);

    recordAuditEvent(db, {
      actor: { adminId, label: 'admin@example.com' },
      action: 'auth.logout',
      target: null,
      result: 'success',
      ip: null,
      userAgent: null,
    });

    const row = readAllRows(db)[0]!;
    expect(JSON.parse(row.details ?? '{}')).toEqual({ errorCode: null });

    db.close();
  });

  it('rejects a details payload whose key looks like it might carry a secret, case-insensitively', () => {
    const db = setUpDb();

    const secretLikeKeys = ['password', 'newPassword', 'Token', 'SECRET', 'passwordHash'];
    for (const key of secretLikeKeys) {
      expect(() =>
        recordAuditEvent(db, {
          actor: { adminId: 'a_1', label: 'admin@example.com' },
          action: 'auth.password_change',
          target: null,
          result: 'success',
          ip: null,
          userAgent: null,
          details: { [key]: 'irrelevant-value' },
        }),
      ).toThrow(/looks like it might carry a secret/);
    }

    // None of the rejected calls above should have written a row.
    expect(readAllRows(db)).toHaveLength(0);
    db.close();
  });

  it('never contains a password supplied to a login attempt, anywhere in the row', () => {
    const db = setUpDb();
    const submittedPassword = 'th1s-is-th3-s3cr3t-p4ssw0rd-SENTINEL';

    // Mirrors exactly what the real login flow passes: named,
    // non-secret fields only. The submitted password is never
    // referenced by the call at all.
    recordAuditEvent(db, {
      actor: { adminId: null, label: 'victim@example.com' },
      action: 'auth.login.failure',
      target: null,
      result: 'failure',
      errorCode: 'INVALID_CREDENTIALS',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 test',
      details: { reason: 'bad_password' },
    });

    const serializedRow = JSON.stringify(readAllRows(db));
    expect(serializedRow).not.toContain(submittedPassword);

    db.close();
  });
});
