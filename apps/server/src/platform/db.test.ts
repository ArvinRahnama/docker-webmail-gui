import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';

function setUpTable(db: ReturnType<typeof createDatabase>): void {
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
}

describe('createDatabase — get/all/run/exec', () => {
  it('runs INSERT/SELECT and reports rows via get/all, changes/lastInsertRowid via run', () => {
    const db = createDatabase(':memory:');
    setUpTable(db);

    const result = db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    expect(Number(result.changes)).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(1);

    db.run('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'b']);

    expect(db.get<{ v: string }>('SELECT v FROM t WHERE id = ?', [1])?.v).toBe('a');
    expect(db.get('SELECT v FROM t WHERE id = ?', [999])).toBeUndefined();
    expect(db.all<{ id: number }>('SELECT id FROM t ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);

    db.close();
  });

  it('enforces foreign_keys = ON', () => {
    const db = createDatabase(':memory:');
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);

    expect(() => db.run('INSERT INTO child (id, parent_id) VALUES (?, ?)', [1, 999])).toThrow();
    db.close();
  });

  it('close() is idempotent', () => {
    const db = createDatabase(':memory:');
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

describe('createDatabase — transaction()', () => {
  it('commits on normal return', () => {
    const db = createDatabase(':memory:');
    setUpTable(db);

    db.transaction(() => {
      db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    });

    expect(db.all('SELECT * FROM t')).toHaveLength(1);
    db.close();
  });

  it('rolls back and rethrows on a thrown error', () => {
    const db = createDatabase(':memory:');
    setUpTable(db);

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.all('SELECT * FROM t')).toHaveLength(0);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it('is re-entrant: a nested transaction() call uses a savepoint instead of a nested BEGIN', () => {
    const db = createDatabase(':memory:');
    setUpTable(db);

    db.transaction(() => {
      db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'outer']);
      db.transaction(() => {
        db.run('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'inner']);
      });
    });

    expect(db.all('SELECT * FROM t')).toHaveLength(2);
    db.close();
  });

  it('an inner transaction() rollback does not roll back the outer one', () => {
    const db = createDatabase(':memory:');
    setUpTable(db);

    db.transaction(() => {
      db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'outer']);
      try {
        db.transaction(() => {
          db.run('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'inner']);
          throw new Error('inner failure');
        });
      } catch {
        // swallowed deliberately — this test is about the outer transaction surviving
      }
      db.run('INSERT INTO t (id, v) VALUES (?, ?)', [3, 'outer-again']);
    });

    const rows = db.all<{ id: number }>('SELECT id FROM t ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
    db.close();
  });

  it('propagates the original error even when the transaction was already closed before cleanup runs', () => {
    // Simulates SQLite auto-rolling-back a transaction on a severe error
    // (e.g. a full disk) ahead of our own cleanup: the callback itself
    // ends the transaction, then throws. Without a best-effort guard,
    // the cleanup ROLLBACK would itself throw "cannot rollback - no
    // transaction is active" and replace this error instead of letting
    // it propagate.
    const db = createDatabase(':memory:');
    setUpTable(db);

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
        db.exec('ROLLBACK'); // pretend SQLite already tore down the transaction
        throw new Error('the real, original failure');
      }),
    ).toThrow('the real, original failure');

    db.close();
  });

  it('propagates the original error even when a nested savepoint was already closed before cleanup runs', () => {
    const db = createDatabase(':memory:');
    setUpTable(db);

    expect(() =>
      db.transaction(() => {
        db.transaction(() => {
          db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
          db.exec('RELEASE SAVEPOINT dwg_txn'); // pretend the savepoint was already torn down
          throw new Error('the real, original nested failure');
        });
      }),
    ).toThrow('the real, original nested failure');

    db.close();
  });
});
