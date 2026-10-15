/**
 * Mailbox bindings and their encrypted transport credential.
 *
 * A binding is apps/mcp's record of *one mailbox identity*: the address plus
 * the opaque fingerprint of the DMS password-hash line it was provisioned
 * against. Every connection for that mailbox hangs off the binding, so a
 * change to the mailbox's identity (password change, delete + recreate)
 * invalidates all of them at once.
 *
 * States:
 *  - `active`          — identity matches; credential (if any) usable.
 *  - `stale`           — the fingerprint changed (password changed or mailbox
 *                        recreated); credential wiped, grants revoked.
 *  - `invalid`         — the mail server rejected the stored credential.
 *  - `mailbox_missing` — absent from the last reconciliation; access blocked
 *                        until it reappears unchanged.
 *  - `revoked`         — the mailbox was deleted. Terminal; never reused.
 */
import type { McpCredentialHealth } from '@dwg/shared';
import type { Database } from '../platform/db.js';
import { generateRowId } from '../crypto/random.js';
import type { SealedSecret } from '../crypto/vault.js';

export type BindingState = 'active' | 'stale' | 'invalid' | 'mailbox_missing' | 'revoked';

export interface BindingRow {
  readonly id: string;
  readonly mailbox: string;
  readonly fingerprint: string;
  readonly state: BindingState;
  readonly stateReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt: string | null;
  readonly lastError: string | null;
  readonly revokedAt: string | null;
}

export interface StoredCredential extends SealedSecret {
  readonly bindingId: string;
  readonly version: number;
  readonly createdAt: string;
}

interface RawBinding {
  id: string;
  mailbox: string;
  fingerprint: string;
  state: string;
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  last_error: string | null;
  revoked_at: string | null;
}

const BINDING_COLUMNS =
  'id, mailbox, fingerprint, state, state_reason, created_at, updated_at, last_verified_at, last_error, revoked_at';

function toBinding(row: RawBinding): BindingRow {
  const state = (['active', 'stale', 'invalid', 'mailbox_missing', 'revoked'] as const).find(
    (candidate) => candidate === row.state,
  );
  return {
    id: row.id,
    mailbox: row.mailbox,
    fingerprint: row.fingerprint,
    // An unknown stored state fails closed as `invalid`.
    state: state ?? 'invalid',
    stateReason: row.state_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
    revokedAt: row.revoked_at,
  };
}

export class BindingsRepository {
  constructor(private readonly db: Database) {}

  findLiveByMailbox(mailbox: string): BindingRow | undefined {
    const row = this.db.get<RawBinding>(
      `SELECT ${BINDING_COLUMNS} FROM mcp_mailbox_bindings WHERE mailbox = ? AND revoked_at IS NULL`,
      [mailbox],
    );
    return row === undefined ? undefined : toBinding(row);
  }

  findById(id: string): BindingRow | undefined {
    const row = this.db.get<RawBinding>(
      `SELECT ${BINDING_COLUMNS} FROM mcp_mailbox_bindings WHERE id = ?`,
      [id],
    );
    return row === undefined ? undefined : toBinding(row);
  }

  listLive(): BindingRow[] {
    return this.db
      .all<RawBinding>(
        `SELECT ${BINDING_COLUMNS} FROM mcp_mailbox_bindings WHERE revoked_at IS NULL ORDER BY mailbox`,
      )
      .map(toBinding);
  }

  create(mailbox: string, fingerprint: string, nowIso: string): BindingRow {
    const id = generateRowId('mb');
    this.db.run(
      `INSERT INTO mcp_mailbox_bindings (id, mailbox, fingerprint, state, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      [id, mailbox, fingerprint, nowIso, nowIso],
    );
    const created = this.findById(id);
    if (created === undefined) throw new Error('binding insert did not persist');
    return created;
  }

  setState(
    id: string,
    state: BindingState,
    reason: string | null,
    nowIso: string,
    lastError: string | null = null,
  ): void {
    this.db.run(
      `UPDATE mcp_mailbox_bindings
          SET state = ?, state_reason = ?, last_error = ?, updated_at = ?,
              revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END
        WHERE id = ?`,
      [state, reason, lastError, nowIso, state, nowIso, id],
    );
  }

  /** Re-anchors a binding to a newly verified identity (after the postmaster re-provisions). */
  reanchor(id: string, fingerprint: string, nowIso: string): void {
    this.db.run(
      `UPDATE mcp_mailbox_bindings
          SET fingerprint = ?, state = 'active', state_reason = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
      [fingerprint, nowIso, id],
    );
  }

  markVerified(id: string, nowIso: string): void {
    this.db.run(
      'UPDATE mcp_mailbox_bindings SET last_verified_at = ?, last_error = NULL, updated_at = ? WHERE id = ?',
      [nowIso, nowIso, id],
    );
  }

  recordError(id: string, message: string, nowIso: string): void {
    this.db.run('UPDATE mcp_mailbox_bindings SET last_error = ?, updated_at = ? WHERE id = ?', [
      message.slice(0, 300),
      nowIso,
      id,
    ]);
  }

  // -- credentials -----------------------------------------------------------

  getCredential(bindingId: string): StoredCredential | undefined {
    const row = this.db.get<{
      binding_id: string;
      key_id: string;
      iv: Uint8Array;
      ciphertext: Uint8Array;
      auth_tag: Uint8Array;
      version: number;
      created_at: string;
    }>(
      'SELECT binding_id, key_id, iv, ciphertext, auth_tag, version, created_at FROM mcp_credentials WHERE binding_id = ?',
      [bindingId],
    );
    if (row === undefined) return undefined;
    return {
      bindingId: row.binding_id,
      keyId: row.key_id,
      iv: Buffer.from(row.iv),
      ciphertext: Buffer.from(row.ciphertext),
      authTag: Buffer.from(row.auth_tag),
      version: row.version,
      createdAt: row.created_at,
    };
  }

  putCredential(bindingId: string, sealed: SealedSecret, nowIso: string): void {
    const existing = this.getCredential(bindingId);
    this.db.run(
      `INSERT INTO mcp_credentials (binding_id, key_id, iv, ciphertext, auth_tag, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(binding_id) DO UPDATE SET
         key_id = excluded.key_id, iv = excluded.iv, ciphertext = excluded.ciphertext,
         auth_tag = excluded.auth_tag, version = excluded.version, created_at = excluded.created_at`,
      [
        bindingId,
        sealed.keyId,
        sealed.iv,
        sealed.ciphertext,
        sealed.authTag,
        (existing?.version ?? 0) + 1,
        nowIso,
      ],
    );
  }

  /** Wipes the stored transport credential (stale identity, revoked mailbox). */
  deleteCredential(bindingId: string): void {
    this.db.run('DELETE FROM mcp_credentials WHERE binding_id = ?', [bindingId]);
  }

  credentialHealth(binding: BindingRow, vaultKeyId: string | null): McpCredentialHealth {
    switch (binding.state) {
      case 'revoked':
        return 'revoked';
      case 'mailbox_missing':
        return 'mailbox_missing';
      case 'stale':
        return 'stale';
      case 'invalid':
        return 'invalid';
      case 'active': {
        const credential = this.getCredential(binding.id);
        if (credential === undefined) return 'missing';
        if (vaultKeyId === null || credential.keyId !== vaultKeyId) return 'vault_unavailable';
        return 'healthy';
      }
    }
  }
}
