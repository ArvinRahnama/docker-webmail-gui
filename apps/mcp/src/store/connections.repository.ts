/**
 * Connections and their enrollment (setup) credentials.
 *
 * A connection's stored `state` is only the postmaster-controlled part
 * (`enabled` | `disabled` | `revoked`); the status shown in the UI
 * (`pending`/`active`/`suspended`/`expired`/…) is *derived* on read from
 * this state plus the binding, the expiry and the live grants — see
 * domain/connections.service.ts. Nothing about a connection's status is
 * ever invented or cached.
 */
import { McpScopeSchema, type McpScope } from '@dwg/shared';
import type { Database } from '../platform/db.js';
import { generateRowId } from '../crypto/random.js';

export type ConnectionState = 'enabled' | 'disabled' | 'revoked';

export interface ConnectionRow {
  readonly id: string;
  readonly bindingId: string;
  readonly mailbox: string;
  readonly label: string;
  readonly scopes: readonly McpScope[];
  readonly senderIdentities: readonly string[];
  readonly state: ConnectionState;
  readonly stateReason: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastAuthorizedAt: string | null;
  readonly lastUsedAt: string | null;
}

interface RawConnection {
  id: string;
  binding_id: string;
  mailbox: string;
  label: string;
  scopes: string;
  sender_identities: string;
  state: string;
  state_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_authorized_at: string | null;
  last_used_at: string | null;
}

const CONNECTION_COLUMNS =
  'id, binding_id, mailbox, label, scopes, sender_identities, state, state_reason, created_by, created_at, updated_at, expires_at, revoked_at, last_authorized_at, last_used_at';

/** Parses a stored scope list, dropping anything unknown (fail closed: an unreadable list grants nothing). */
export function parseScopes(raw: string): McpScope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: McpScope[] = [];
    for (const item of parsed) {
      const scope = McpScopeSchema.safeParse(item);
      if (scope.success && !out.includes(scope.data)) out.push(scope.data);
    }
    return out;
  } catch {
    return [];
  }
}

function parseStringList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function toConnection(row: RawConnection): ConnectionRow {
  const state: ConnectionState =
    row.state === 'enabled' ? 'enabled' : row.state === 'disabled' ? 'disabled' : 'revoked';
  return {
    id: row.id,
    bindingId: row.binding_id,
    mailbox: row.mailbox,
    label: row.label,
    scopes: parseScopes(row.scopes),
    senderIdentities: parseStringList(row.sender_identities),
    state,
    stateReason: row.state_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastAuthorizedAt: row.last_authorized_at,
    lastUsedAt: row.last_used_at,
  };
}

export interface EnrollmentRow {
  readonly id: string;
  readonly connectionId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly reservedCodeId: string | null;
  readonly reservedUntil: string | null;
  readonly failedAttempts: number;
  readonly lockedAt: string | null;
  readonly revokedAt: string | null;
}

interface RawEnrollment {
  id: string;
  connection_id: string;
  username: string;
  password_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  reserved_code_id: string | null;
  reserved_until: string | null;
  failed_attempts: number;
  locked_at: string | null;
  revoked_at: string | null;
}

const ENROLLMENT_COLUMNS =
  'id, connection_id, username, password_hash, issued_at, expires_at, consumed_at, reserved_code_id, reserved_until, failed_attempts, locked_at, revoked_at';

function toEnrollment(row: RawEnrollment): EnrollmentRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    username: row.username,
    passwordHash: row.password_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    reservedCodeId: row.reserved_code_id,
    reservedUntil: row.reserved_until,
    failedAttempts: Number(row.failed_attempts),
    lockedAt: row.locked_at,
    revokedAt: row.revoked_at,
  };
}

/** Maximum failed setup-password attempts before an enrollment locks (requires a reissue). */
export const ENROLLMENT_MAX_FAILED_ATTEMPTS = 5;

export class ConnectionsRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): ConnectionRow | undefined {
    const row = this.db.get<RawConnection>(
      `SELECT ${CONNECTION_COLUMNS} FROM mcp_connections WHERE id = ?`,
      [id],
    );
    return row === undefined ? undefined : toConnection(row);
  }

  listAll(): ConnectionRow[] {
    return this.db
      .all<RawConnection>(
        `SELECT ${CONNECTION_COLUMNS} FROM mcp_connections ORDER BY created_at DESC`,
      )
      .map(toConnection);
  }

  listByBinding(bindingId: string): ConnectionRow[] {
    return this.db
      .all<RawConnection>(
        `SELECT ${CONNECTION_COLUMNS} FROM mcp_connections WHERE binding_id = ? ORDER BY created_at DESC`,
        [bindingId],
      )
      .map(toConnection);
  }

  listByMailbox(mailbox: string): ConnectionRow[] {
    return this.db
      .all<RawConnection>(
        `SELECT ${CONNECTION_COLUMNS} FROM mcp_connections WHERE mailbox = ? ORDER BY created_at DESC`,
        [mailbox],
      )
      .map(toConnection);
  }

  countNonRevokedForBinding(bindingId: string): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM mcp_connections WHERE binding_id = ? AND state <> 'revoked'",
      [bindingId],
    );
    return Number(row?.n ?? 0);
  }

  create(input: {
    readonly id: string;
    readonly bindingId: string;
    readonly mailbox: string;
    readonly label: string;
    readonly scopes: readonly McpScope[];
    readonly senderIdentities: readonly string[];
    readonly createdBy: string;
    readonly expiresAt: string | null;
    readonly nowIso: string;
  }): ConnectionRow {
    this.db.run(
      `INSERT INTO mcp_connections
         (id, binding_id, mailbox, label, scopes, sender_identities, state, created_by, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?, ?)`,
      [
        input.id,
        input.bindingId,
        input.mailbox,
        input.label,
        JSON.stringify(input.scopes),
        JSON.stringify(input.senderIdentities),
        input.createdBy,
        input.nowIso,
        input.nowIso,
        input.expiresAt,
      ],
    );
    const created = this.findById(input.id);
    if (created === undefined) throw new Error('connection insert did not persist');
    return created;
  }

  update(
    id: string,
    fields: {
      readonly label?: string | undefined;
      readonly scopes?: readonly McpScope[] | undefined;
      readonly senderIdentities?: readonly string[] | undefined;
      readonly expiresAt?: string | null | undefined;
    },
    nowIso: string,
  ): void {
    const current = this.findById(id);
    if (current === undefined) return;
    this.db.run(
      `UPDATE mcp_connections
          SET label = ?, scopes = ?, sender_identities = ?, expires_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        fields.label ?? current.label,
        JSON.stringify(fields.scopes ?? current.scopes),
        JSON.stringify(fields.senderIdentities ?? current.senderIdentities),
        fields.expiresAt === undefined ? current.expiresAt : fields.expiresAt,
        nowIso,
        id,
      ],
    );
  }

  setState(id: string, state: ConnectionState, reason: string | null, nowIso: string): void {
    this.db.run(
      `UPDATE mcp_connections
          SET state = ?, state_reason = ?, updated_at = ?,
              revoked_at = CASE WHEN ? = 'revoked' THEN COALESCE(revoked_at, ?) ELSE revoked_at END
        WHERE id = ? AND state <> 'revoked'`,
      [state, reason, nowIso, state, nowIso, id],
    );
  }

  touchAuthorized(id: string, nowIso: string): void {
    this.db.run('UPDATE mcp_connections SET last_authorized_at = ? WHERE id = ?', [nowIso, id]);
  }

  touchUsed(id: string, nowIso: string): void {
    this.db.run('UPDATE mcp_connections SET last_used_at = ? WHERE id = ?', [nowIso, id]);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM mcp_connections WHERE id = ?', [id]);
  }

  // -- enrollments -------------------------------------------------------------

  currentEnrollment(connectionId: string): EnrollmentRow | undefined {
    const row = this.db.get<RawEnrollment>(
      `SELECT ${ENROLLMENT_COLUMNS} FROM mcp_enrollment_credentials
        WHERE connection_id = ? ORDER BY issued_at DESC, id DESC LIMIT 1`,
      [connectionId],
    );
    return row === undefined ? undefined : toEnrollment(row);
  }

  findEnrollmentByUsername(username: string): EnrollmentRow | undefined {
    const row = this.db.get<RawEnrollment>(
      `SELECT ${ENROLLMENT_COLUMNS} FROM mcp_enrollment_credentials WHERE username = ?`,
      [username],
    );
    return row === undefined ? undefined : toEnrollment(row);
  }

  findEnrollmentById(id: string): EnrollmentRow | undefined {
    const row = this.db.get<RawEnrollment>(
      `SELECT ${ENROLLMENT_COLUMNS} FROM mcp_enrollment_credentials WHERE id = ?`,
      [id],
    );
    return row === undefined ? undefined : toEnrollment(row);
  }

  /** Revokes every not-yet-revoked enrollment for the connection, then inserts the new one. */
  issueEnrollment(input: {
    readonly connectionId: string;
    readonly username: string;
    readonly passwordHash: string;
    readonly expiresAt: string;
    readonly nowIso: string;
  }): EnrollmentRow {
    const id = generateRowId('en');
    this.db.transaction(() => {
      this.revokeEnrollments(input.connectionId, input.nowIso);
      this.db.run(
        `INSERT INTO mcp_enrollment_credentials (id, connection_id, username, password_hash, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, input.connectionId, input.username, input.passwordHash, input.nowIso, input.expiresAt],
      );
    });
    const created = this.findEnrollmentById(id);
    if (created === undefined) throw new Error('enrollment insert did not persist');
    return created;
  }

  /** Replaces the secret of an existing enrollment and returns it to a fresh, unused state. */
  resetEnrollment(
    enrollmentId: string,
    passwordHash: string,
    expiresAt: string,
    nowIso: string,
  ): void {
    this.db.run(
      `UPDATE mcp_enrollment_credentials
          SET password_hash = ?, issued_at = ?, expires_at = ?, consumed_at = NULL,
              reserved_code_id = NULL, reserved_until = NULL, failed_attempts = 0,
              locked_at = NULL, revoked_at = NULL
        WHERE id = ?`,
      [passwordHash, nowIso, expiresAt, enrollmentId],
    );
  }

  revokeEnrollments(connectionId: string, nowIso: string): void {
    this.db.run(
      'UPDATE mcp_enrollment_credentials SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL',
      [nowIso, connectionId],
    );
  }

  /** Atomically increments the failure counter and locks at the threshold. Returns the new count. */
  recordFailedAttempt(enrollmentId: string, nowIso: string): number {
    this.db.run(
      `UPDATE mcp_enrollment_credentials
          SET failed_attempts = failed_attempts + 1,
              locked_at = CASE WHEN failed_attempts + 1 >= ? AND locked_at IS NULL THEN ? ELSE locked_at END
        WHERE id = ?`,
      [ENROLLMENT_MAX_FAILED_ATTEMPTS, nowIso, enrollmentId],
    );
    return this.findEnrollmentById(enrollmentId)?.failedAttempts ?? ENROLLMENT_MAX_FAILED_ATTEMPTS;
  }

  /**
   * Reserves an unconsumed enrollment for one authorization code. Conditional
   * UPDATE so two concurrent approvals with the same setup password cannot
   * both succeed: only the one that flips the row wins.
   */
  reserveEnrollment(
    enrollmentId: string,
    codeId: string,
    untilIso: string,
    nowIso: string,
  ): boolean {
    const result = this.db.run(
      `UPDATE mcp_enrollment_credentials
          SET reserved_code_id = ?, reserved_until = ?
        WHERE id = ?
          AND consumed_at IS NULL AND revoked_at IS NULL AND locked_at IS NULL
          AND expires_at > ?
          AND (reserved_until IS NULL OR reserved_until <= ?)`,
      [codeId, untilIso, enrollmentId, nowIso, nowIso],
    );
    return Number(result.changes) === 1;
  }

  /** Consumes the enrollment when its reserved code is redeemed. Conditional, single-winner. */
  consumeEnrollment(enrollmentId: string, codeId: string, nowIso: string): boolean {
    const result = this.db.run(
      `UPDATE mcp_enrollment_credentials
          SET consumed_at = ?, reserved_until = NULL
        WHERE id = ? AND reserved_code_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      [nowIso, enrollmentId, codeId],
    );
    return Number(result.changes) === 1;
  }
}
