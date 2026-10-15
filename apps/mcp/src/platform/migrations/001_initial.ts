/**
 * apps/mcp's initial schema. Every table is `STRICT`; timestamps are
 * ISO-8601 TEXT so they sort and compare as strings (same convention as
 * apps/server's migration 001).
 *
 * What is stored, and what deliberately is not:
 *
 *  - **Setup passwords**: Argon2id hash only (`mcp_enrollment_credentials.password_hash`).
 *  - **OAuth tokens and codes**: SHA-256 hash only — they are 256-bit CSPRNG
 *    values, so a slow KDF buys nothing (same reasoning as admin sessions,
 *    apps/server/src/modules/auth/tokens.ts).
 *  - **Mailbox IMAP/SMTP password**: AES-256-GCM ciphertext only
 *    (`mcp_credentials`), keyed by a secret that never touches this database.
 *  - **Mailbox identity**: an opaque SHA-256 fingerprint of the DMS
 *    password-hash line, never the hash itself.
 *  - **Message content**: never. `mcp_operations` keeps only what restoring
 *    or de-duplicating an operation needs (folder, UID, UIDVALIDITY,
 *    Message-ID header, recipient count).
 */
import type { Database } from '../db.js';
import type { Migration } from './runner.js';

const UP_SQL = `
  CREATE TABLE mcp_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- One live binding per mailbox address; a deleted mailbox's binding is
  -- revoked (revoked_at set) and never reused, so recreating the address
  -- produces a fresh binding with no grants (docs/mcp-integration.md §Isolation).
  CREATE TABLE mcp_mailbox_bindings (
    id TEXT PRIMARY KEY,
    mailbox TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    state_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_verified_at TEXT,
    last_error TEXT,
    revoked_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX idx_mcp_bindings_live_mailbox
    ON mcp_mailbox_bindings(mailbox) WHERE revoked_at IS NULL;

  CREATE TABLE mcp_credentials (
    binding_id TEXT PRIMARY KEY REFERENCES mcp_mailbox_bindings(id) ON DELETE CASCADE,
    key_id TEXT NOT NULL,
    iv BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE mcp_connections (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES mcp_mailbox_bindings(id),
    mailbox TEXT NOT NULL,
    label TEXT NOT NULL,
    scopes TEXT NOT NULL,
    sender_identities TEXT NOT NULL,
    state TEXT NOT NULL,
    state_reason TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_authorized_at TEXT,
    last_used_at TEXT
  ) STRICT;
  CREATE INDEX idx_mcp_connections_mailbox ON mcp_connections(mailbox);
  CREATE INDEX idx_mcp_connections_binding ON mcp_connections(binding_id);

  CREATE TABLE mcp_enrollment_credentials (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    reserved_code_id TEXT,
    reserved_until TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_at TEXT,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX idx_mcp_enrollment_connection ON mcp_enrollment_credentials(connection_id);

  CREATE TABLE mcp_oauth_clients (
    client_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_name TEXT,
    client_uri TEXT,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL,
    client_secret_hash TEXT,
    metadata_fetched_at TEXT,
    metadata_expires_at TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  ) STRICT;

  CREATE TABLE mcp_oauth_authorization_requests (
    id TEXT PRIMARY KEY,
    csrf_token_hash TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    state TEXT,
    code_challenge TEXT NOT NULL,
    requested_scopes TEXT,
    resource TEXT,
    connection_id TEXT,
    enrollment_id TEXT,
    authenticated_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    ip TEXT
  ) STRICT;
  CREATE INDEX idx_mcp_authz_requests_expires ON mcp_oauth_authorization_requests(expires_at);

  CREATE TABLE mcp_oauth_grants (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    client_name TEXT,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT
  ) STRICT;
  CREATE INDEX idx_mcp_grants_connection ON mcp_oauth_grants(connection_id);

  CREATE TABLE mcp_oauth_authorization_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    enrollment_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    redeemed_at TEXT,
    grant_id TEXT
  ) STRICT;

  CREATE TABLE mcp_oauth_access_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX idx_mcp_access_tokens_grant ON mcp_oauth_access_tokens(grant_id);

  CREATE TABLE mcp_oauth_refresh_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX idx_mcp_refresh_tokens_grant ON mcp_oauth_refresh_tokens(grant_id);

  -- Write operations performed through tools: send / delete-to-Trash / restore.
  -- details holds only what restoration or de-duplication needs.
  CREATE TABLE mcp_operations (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT,
    details TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;
  CREATE INDEX idx_mcp_operations_connection_kind_time
    ON mcp_operations(connection_id, kind, created_at);
  CREATE UNIQUE INDEX idx_mcp_operations_idempotency
    ON mcp_operations(connection_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL;

  CREATE TABLE mcp_login_attempts (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    username TEXT NOT NULL,
    success INTEGER NOT NULL,
    attempted_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_mcp_login_attempts_ip_time ON mcp_login_attempts(ip, attempted_at);

  -- Security/activity trail. Rows are never updated (trigger below); old rows
  -- are removed only by the retention sweep (auditRetentionDays).
  CREATE TABLE mcp_audit_events (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    connection_id TEXT,
    mailbox TEXT,
    actor TEXT NOT NULL,
    event TEXT NOT NULL,
    result TEXT NOT NULL,
    ip TEXT,
    details TEXT NOT NULL
  ) STRICT;
  CREATE INDEX idx_mcp_audit_occurred ON mcp_audit_events(occurred_at);
  CREATE INDEX idx_mcp_audit_connection_time ON mcp_audit_events(connection_id, occurred_at);

  CREATE TRIGGER trg_mcp_audit_no_update
  BEFORE UPDATE ON mcp_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'mcp_audit_events is append-only: updates are not permitted');
  END;
`;

function up(db: Database): void {
  db.exec(UP_SQL);
}

export const migration001Initial: Migration = {
  version: 1,
  name: 'mcp_initial',
  up,
};
