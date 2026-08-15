/**
 * Forward-only migration runner (ARCHITECTURE.md §7.3). Applies numbered
 * migrations inside a transaction and records each in
 * `schema_migrations`. Never guesses: if the database has already been
 * migrated past what this build of the code knows about, it refuses to
 * start rather than risk running an old build against a newer schema.
 */
import type { Database } from '../db.js';

export interface Migration {
  /** Forward-only, strictly increasing, applied in ascending order. */
  readonly version: number;
  /** Human-readable name, recorded alongside the version for operators reading the table directly. */
  readonly name: string;
  /** Applies this migration's schema changes. Runs inside a transaction — throw to abort and roll back. */
  readonly up: (db: Database) => void;
}

interface AppliedMigrationRow {
  readonly version: number;
}

/**
 * `schema_migrations` bookkeeping is owned by the runner itself, not by
 * migration 001 — the runner has to be able to query "what's already
 * applied" *before* it can decide whether 001 needs to run, so this
 * table's own creation can't be one of the numbered migrations it is
 * checking for. This statement is idempotent and intentionally outside
 * the numbered-migration list; ARCHITECTURE.md §7.3 still lists
 * `schema_migrations` as one of the ~11 tables — this is where it
 * actually comes from.
 */
const BOOTSTRAP_SCHEMA_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT
`;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function assertNoDuplicateVersions(migrations: readonly Migration[]): void {
  const seen = new Map<number, string>();
  for (const migration of migrations) {
    const existing = seen.get(migration.version);
    if (existing !== undefined) {
      throw new MigrationError(
        `Migration version ${migration.version} is declared twice ("${existing}" and "${migration.name}"). Each migration version must be unique.`,
      );
    }
    seen.set(migration.version, migration.name);
  }
}

/**
 * Applies every migration in `migrations` that is not yet recorded in
 * `schema_migrations`, in ascending version order, each inside its own
 * transaction. Idempotent: migrations already recorded are skipped, so
 * calling this repeatedly against the same database is a no-op after
 * the first run.
 *
 * Refuses to start (throws {@link MigrationError} without applying
 * anything) if the database's highest applied version is newer than
 * the highest version in `migrations` — ARCHITECTURE.md §7.3's "refuses
 * to start on an unknown future schema version rather than guessing."
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): void {
  assertNoDuplicateVersions(migrations);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  db.exec(BOOTSTRAP_SCHEMA_MIGRATIONS_TABLE);

  const appliedRows = db.all<AppliedMigrationRow>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  const knownMaxVersion = sorted.length > 0 ? sorted[sorted.length - 1]!.version : 0;
  const appliedMaxVersion = appliedRows.reduce((max, row) => Math.max(max, row.version), 0);

  if (appliedMaxVersion > knownMaxVersion) {
    throw new MigrationError(
      `Database schema is at migration version ${appliedMaxVersion}, but this build only knows about migrations up to version ${knownMaxVersion}. ` +
        'Refusing to start: running an older build against a newer database risks silent data corruption. ' +
        'Upgrade the application to a version that recognises this schema before starting it against this database.',
    );
  }

  for (const migration of sorted) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
  }
}
