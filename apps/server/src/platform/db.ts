/**
 * Thin wrapper over `node:sqlite`'s `DatabaseSync` (ARCHITECTURE.md §3,
 * §3.1 — the built-in driver, deliberately not `better-sqlite3`). Every
 * call site talks to the {@link Database} interface exported here, never
 * to `DatabaseSync` directly, so the driver stays swappable in this one
 * module if `node:sqlite`'s Release Candidate status ever forces a
 * change (IMPLEMENTATION_PLAN.md §4).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded via createRequire rather than a static `import … from 'node:sqlite'`.
// node:sqlite is new enough that the test runner's bundled dependency
// (vite-node, inside vitest) has a hardcoded builtin-module list that
// doesn't yet include it, and fails to resolve a static import of it
// during tests (it does not affect the real `node dist/index.js`
// runtime, only the transform pipeline tests run through). A `require()`
// call is just a normal function call as far as that static analysis is
// concerned, so it is never subject to the same specifier resolution —
// Node's own loader still handles it exactly like any other builtin
// either way. Only the type import above is a real ESM import; that's
// erased at compile time and never reaches the module loader.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** Positional `?` parameters only — enough for every M2 call site, and simple to reason about for injection-safety review (SECURITY.md §3.8). */
export type SqlParams = readonly unknown[];

export interface RunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface Database {
  /** Runs `sql` and returns the first result row, or `undefined` if there is none. */
  get<Row = Record<string, unknown>>(sql: string, params?: SqlParams): Row | undefined;
  /** Runs `sql` and returns every result row. */
  all<Row = Record<string, unknown>>(sql: string, params?: SqlParams): Row[];
  /** Runs `sql` (INSERT/UPDATE/DELETE) and returns change/rowid info. */
  run(sql: string, params?: SqlParams): RunResult;
  /** Executes one or more `;`-separated statements with no parameter binding and no result — schema/pragma statements. */
  exec(sql: string): void;
  /**
   * Runs `fn` inside a transaction, committing on normal return and
   * rolling back if `fn` throws (the thrown error propagates to the
   * caller either way). Safe to call re-entrantly — a `transaction()`
   * invoked while already inside one uses a `SAVEPOINT` instead of a
   * nested `BEGIN` (which SQLite rejects outright), so a service method
   * that wraps its own transaction can safely call another that does
   * the same.
   */
  transaction<T>(fn: () => T): T;
  /** True while a transaction (or savepoint) started by {@link transaction} is open. */
  readonly isTransaction: boolean;
  close(): void;
}

export interface CreateDatabaseOptions {
  /** Busy timeout in milliseconds — how long SQLite waits for a lock before giving up. */
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Fixed SAVEPOINT name used for every re-entrant `transaction()` call.
 * It does not need to be unique: SQLite tracks savepoints as a stack, a
 * `RELEASE`/`ROLLBACK TO` always targets the innermost savepoint with a
 * given name, and this wrapper only ever releases (or rolls back) the
 * savepoint it just opened before control returns to whichever caller
 * opened the next one out — synchronous call nesting is inherently
 * LIFO, so reuse here is safe by construction. Using a constant also
 * keeps every statement below a plain string literal, with no
 * interpolation or concatenation feeding `exec()`.
 */
const SAVEPOINT_NAME = 'dwg_txn';

// Precomputed as plain constants (not built inline at the call site) so
// each `exec()` call below passes a plain string identifier rather than
// a template literal or concatenation — both are flagged by the
// no-restricted-syntax rule for `exec`/`execSync` calls (SECURITY.md
// §3.2's shell-injection guard), which pattern-matches on the *method
// name* and can't tell `DatabaseSync#exec` (runs SQL) apart from
// `child_process.exec` (runs a shell). There is no user input in any of
// these three statements either way — SAVEPOINT_NAME is the fixed
// constant above — but keeping the strings fully static here is the
// simplest way to stay clearly outside that rule's pattern rather than
// arguing it's a false positive at every call site.
const SAVEPOINT_SQL = `SAVEPOINT ${SAVEPOINT_NAME}`;
const RELEASE_SAVEPOINT_SQL = `RELEASE SAVEPOINT ${SAVEPOINT_NAME}`;
const ROLLBACK_TO_SAVEPOINT_SQL = `ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`;

class SqliteDatabase implements Database {
  private readonly raw: DatabaseSyncType;

  constructor(location: string, options: CreateDatabaseOptions = {}) {
    this.raw = new DatabaseSync(location, {
      enableForeignKeyConstraints: true, // pragma foreign_keys = ON
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, // pragma busy_timeout
    });
    // No constructor option for journal mode; WAL is a no-op on ':memory:'
    // databases (SQLite keeps them in-memory journal mode regardless) and
    // takes effect normally on file-backed ones.
    this.raw.exec('PRAGMA journal_mode = WAL');
  }

  get<Row = Record<string, unknown>>(sql: string, params: SqlParams = []): Row | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  all<Row = Record<string, unknown>>(sql: string, params: SqlParams = []): Row[] {
    return this.raw.prepare(sql).all(...(params as never[])) as Row[];
  }

  run(sql: string, params: SqlParams = []): RunResult {
    return this.raw.prepare(sql).run(...(params as never[]));
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get isTransaction(): boolean {
    return this.raw.isTransaction;
  }

  transaction<T>(fn: () => T): T {
    if (this.raw.isTransaction) {
      this.raw.exec(SAVEPOINT_SQL);
      try {
        const result = fn();
        this.raw.exec(RELEASE_SAVEPOINT_SQL);
        return result;
      } catch (err) {
        this.rollbackSavepointBestEffort();
        throw err;
      }
    }

    this.raw.exec('BEGIN');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.rollbackBestEffort();
      throw err;
    }
  }

  /**
   * Best-effort cleanup: SQLite can end a transaction on its own on some
   * errors (e.g. it auto-rolls-back on a full-disk condition), in which
   * case `ROLLBACK` here would itself throw "cannot rollback - no
   * transaction is active". Swallowing that keeps the *original* error
   * — the one that actually matters, and that told us the disk was full
   * — propagating to the caller instead of being silently replaced by a
   * confusing one about the cleanup step.
   */
  private rollbackBestEffort(): void {
    try {
      this.raw.exec('ROLLBACK');
    } catch {
      // Already rolled back by SQLite itself; nothing left to undo.
    }
  }

  private rollbackSavepointBestEffort(): void {
    try {
      this.raw.exec(ROLLBACK_TO_SAVEPOINT_SQL);
      this.raw.exec(RELEASE_SAVEPOINT_SQL);
    } catch {
      // Enclosing transaction/savepoint was already torn down by SQLite
      // itself; nothing left to undo. See rollbackBestEffort() above.
    }
  }

  close(): void {
    if (this.raw.isOpen) {
      this.raw.close();
    }
  }
}

/**
 * Opens a database at an exact location — a file path, or the special
 * value `':memory:'`. Use this directly in tests. Production code
 * (needing directory creation from `DATA_DIR`) should use
 * {@link openAppDatabase} instead.
 */
export function createDatabase(location: string, options?: CreateDatabaseOptions): Database {
  return new SqliteDatabase(location, options);
}

/** Filename of the server's own SQLite database within `DATA_DIR`. */
export const APP_DATABASE_FILENAME = 'app.db';

/**
 * Opens the server's own database inside `dataDir` (ARCHITECTURE.md
 * §7.3), creating the directory first if it does not exist.
 */
export function openAppDatabase(dataDir: string, options?: CreateDatabaseOptions): Database {
  mkdirSync(dataDir, { recursive: true });
  return createDatabase(join(dataDir, APP_DATABASE_FILENAME), options);
}
