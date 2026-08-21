/**
 * SQL access for the config editor's two tables: `settings` (migration
 * 001 — generic key/value store; here it holds the last-applied override
 * per allowlisted key) and `config_snapshots` (migration 004 — one row
 * per apply, the pre-change rollback point FEATURE_MATRIX.md §28-29
 * requires). Mirrors `platform/jobs/jobs.repository.ts`'s shape: one
 * named method per operation, no SQL anywhere else in this module.
 */
import type { Database } from '../../platform/db.js';
import { generateId } from '../../platform/errors.js';
import type { ConfigSnapshotRecord } from '@dwg/shared';

interface SettingRow {
  readonly key: string;
  readonly value: string;
  readonly updated_at: string;
}

interface SnapshotRow {
  readonly id: string;
  readonly created_at: string;
  readonly created_by_admin_id: string | null;
  readonly created_by_label: string;
  readonly values_json: string;
}

function toSnapshotRecord(row: SnapshotRow): ConfigSnapshotRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    createdByAdminId: row.created_by_admin_id,
    createdByLabel: row.created_by_label,
    values: JSON.parse(row.values_json) as Record<string, string>,
  };
}

const DEFAULT_SNAPSHOT_LIST_LIMIT = 20;

export class ConfigRepository {
  constructor(private readonly db: Database) {}

  /** The last-applied override for one allowlisted key, or `null` if the admin has never changed it away from its environment default. */
  getOverride(key: string): string | null {
    const row = this.db.get<SettingRow>('SELECT * FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  getAllOverrides(): ReadonlyMap<string, string> {
    const rows = this.db.all<SettingRow>('SELECT * FROM settings');
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  /** Upserts one key's override — `apply()` calls this once per changed key inside a transaction (`config.service.ts`), never as a bare loop of independent writes. */
  setOverride(key: string, value: string, updatedAt: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, updatedAt],
    );
  }

  /** Records a pre-change snapshot — the *complete* current allowlisted-settings state (secrets included, unmasked), never exposed back over the API (`@dwg/shared`'s `ConfigSnapshotSchema` doc comment). Returns the generated id so the caller can echo it in `ApplyConfigResponse.snapshotId`. */
  insertSnapshot(params: {
    readonly createdByAdminId: string | null;
    readonly createdByLabel: string;
    readonly values: Readonly<Record<string, string>>;
  }): string {
    const id = generateId('cfs');
    this.db.run(
      `INSERT INTO config_snapshots (id, created_at, created_by_admin_id, created_by_label, values_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        new Date().toISOString(),
        params.createdByAdminId,
        params.createdByLabel,
        JSON.stringify(params.values),
      ],
    );
    return id;
  }

  getSnapshotById(id: string): ConfigSnapshotRecord | null {
    const row = this.db.get<SnapshotRow>('SELECT * FROM config_snapshots WHERE id = ?', [id]);
    return row ? toSnapshotRecord(row) : null;
  }

  listSnapshots(limit: number = DEFAULT_SNAPSHOT_LIST_LIMIT): readonly ConfigSnapshotRecord[] {
    const rows = this.db.all<SnapshotRow>(
      'SELECT * FROM config_snapshots ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(toSnapshotRecord);
  }
}
