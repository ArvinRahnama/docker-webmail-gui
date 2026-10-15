/**
 * Write operations performed through MCP tools — the record that makes
 * sends idempotent and rate-limited, and Trash moves restorable. `details`
 * holds only identifiers (folder/UID/UIDVALIDITY, Message-ID, counts);
 * never a subject, body, attachment or recipient list.
 */
import type { Database } from '../platform/db.js';
import { generateRowId } from '../crypto/random.js';

export type OperationKind = 'send' | 'delete' | 'restore';
export type OperationStatus = 'pending' | 'completed' | 'failed' | 'unknown';

export type OperationDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface OperationRow {
  readonly id: string;
  readonly connectionId: string;
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  readonly idempotencyKey: string | null;
  readonly details: OperationDetails;
  readonly error: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface RawOperation {
  id: string;
  connection_id: string;
  kind: string;
  status: string;
  idempotency_key: string | null;
  details: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

const COLUMNS =
  'id, connection_id, kind, status, idempotency_key, details, error, created_at, completed_at';

function toRow(row: RawOperation): OperationRow {
  let details: OperationDetails = {};
  try {
    const parsed: unknown = JSON.parse(row.details);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      details = parsed as OperationDetails;
  } catch {
    details = {};
  }
  return {
    id: row.id,
    connectionId: row.connection_id,
    kind: row.kind === 'delete' ? 'delete' : row.kind === 'restore' ? 'restore' : 'send',
    status:
      (['pending', 'completed', 'failed', 'unknown'] as const).find((s) => s === row.status) ??
      'unknown',
    idempotencyKey: row.idempotency_key,
    details,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class OperationsRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    readonly connectionId: string;
    readonly kind: OperationKind;
    readonly status: OperationStatus;
    readonly idempotencyKey: string | null;
    readonly details: OperationDetails;
    readonly nowIso: string;
  }): OperationRow {
    const id = generateRowId('op');
    this.db.run(
      `INSERT INTO mcp_operations (id, connection_id, kind, status, idempotency_key, details, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.connectionId,
        input.kind,
        input.status,
        input.idempotencyKey,
        JSON.stringify(input.details),
        input.nowIso,
        input.status === 'pending' ? null : input.nowIso,
      ],
    );
    const row = this.find(id);
    if (row === undefined) throw new Error('operation insert did not persist');
    return row;
  }

  find(id: string): OperationRow | undefined {
    const row = this.db.get<RawOperation>(`SELECT ${COLUMNS} FROM mcp_operations WHERE id = ?`, [
      id,
    ]);
    return row === undefined ? undefined : toRow(row);
  }

  /** Scoped lookup: an operation id from one connection is invisible to every other. */
  findForConnection(
    id: string,
    connectionId: string,
    kind: OperationKind,
  ): OperationRow | undefined {
    const row = this.db.get<RawOperation>(
      `SELECT ${COLUMNS} FROM mcp_operations WHERE id = ? AND connection_id = ? AND kind = ?`,
      [id, connectionId, kind],
    );
    return row === undefined ? undefined : toRow(row);
  }

  findByIdempotencyKey(
    connectionId: string,
    kind: OperationKind,
    key: string,
  ): OperationRow | undefined {
    const row = this.db.get<RawOperation>(
      `SELECT ${COLUMNS} FROM mcp_operations WHERE connection_id = ? AND kind = ? AND idempotency_key = ?`,
      [connectionId, kind, key],
    );
    return row === undefined ? undefined : toRow(row);
  }

  finish(
    id: string,
    status: Exclude<OperationStatus, 'pending'>,
    details: OperationDetails,
    error: string | null,
    nowIso: string,
  ): void {
    this.db.run(
      'UPDATE mcp_operations SET status = ?, details = ?, error = ?, completed_at = ? WHERE id = ?',
      [status, JSON.stringify(details), error === null ? null : error.slice(0, 300), nowIso, id],
    );
  }

  /** Sends that count against rate limits: anything that may have reached the SMTP server. */
  countSendsSince(connectionId: string, sinceIso: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mcp_operations
        WHERE connection_id = ? AND kind = 'send' AND status IN ('pending', 'completed', 'unknown') AND created_at >= ?`,
      [connectionId, sinceIso],
    );
    return Number(row?.n ?? 0);
  }

  /** Marks a delete operation restored; single-winner so a message is never restored twice. */
  markRestored(id: string, nowIso: string): boolean {
    const row = this.find(id);
    if (row === undefined || row.details['restoredAt'] !== undefined) return false;
    const result = this.db.run(
      `UPDATE mcp_operations SET details = ? WHERE id = ? AND json_extract(details, '$.restoredAt') IS NULL`,
      [JSON.stringify({ ...row.details, restoredAt: nowIso }), id],
    );
    return Number(result.changes) === 1;
  }
}
