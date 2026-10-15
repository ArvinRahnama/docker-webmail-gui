/**
 * OAuth persistence: registered/fetched clients, in-flight authorization
 * requests (the browser transaction), authorization codes, grants, and
 * access/refresh tokens. Codes and tokens are stored as SHA-256 hashes only.
 *
 * Every state transition that must happen at most once — redeeming a code,
 * rotating a refresh token — is a conditional `UPDATE … WHERE <still
 * unused>` whose change count decides the winner. Two concurrent requests
 * presenting the same code or refresh token cannot both succeed; the loser
 * is treated as a replay.
 */
import type { McpScope } from '@dwg/shared';
import type { Database } from '../platform/db.js';
import { generateRowId } from '../crypto/random.js';
import { parseScopes } from './connections.repository.js';

export type ClientKind = 'dcr' | 'cimd';
export type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface OAuthClientRow {
  readonly clientId: string;
  readonly kind: ClientKind;
  readonly clientName: string | null;
  readonly clientUri: string | null;
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly string[];
  readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  readonly clientSecretHash: string | null;
  readonly metadataFetchedAt: string | null;
  readonly metadataExpiresAt: string | null;
  readonly createdAt: string;
}

export interface AuthorizationRequestRow {
  readonly id: string;
  readonly csrfTokenHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly requestedScopes: readonly McpScope[] | null;
  readonly resource: string | null;
  readonly connectionId: string | null;
  readonly enrollmentId: string | null;
  readonly authenticatedAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
}

export interface AuthorizationCodeRow {
  readonly id: string;
  readonly requestId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly McpScope[];
  readonly resource: string;
  readonly connectionId: string;
  readonly enrollmentId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly redeemedAt: string | null;
  readonly grantId: string | null;
}

export interface GrantRow {
  readonly id: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly clientName: string | null;
  readonly redirectUri: string;
  readonly scopes: readonly McpScope[];
  readonly resource: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

export interface AccessTokenRow {
  readonly id: string;
  readonly grantId: string;
  readonly connectionId: string;
  readonly scopes: readonly McpScope[];
  readonly resource: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface RefreshTokenRow {
  readonly id: string;
  readonly grantId: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
}

function jsonList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export class OAuthRepository {
  constructor(private readonly db: Database) {}

  // -- clients ---------------------------------------------------------------

  findClient(clientId: string): OAuthClientRow | undefined {
    const row = this.db.get<{
      client_id: string;
      kind: string;
      client_name: string | null;
      client_uri: string | null;
      redirect_uris: string;
      grant_types: string;
      token_endpoint_auth_method: string;
      client_secret_hash: string | null;
      metadata_fetched_at: string | null;
      metadata_expires_at: string | null;
      created_at: string;
    }>(
      `SELECT client_id, kind, client_name, client_uri, redirect_uris, grant_types, token_endpoint_auth_method,
              client_secret_hash, metadata_fetched_at, metadata_expires_at, created_at
         FROM mcp_oauth_clients WHERE client_id = ?`,
      [clientId],
    );
    if (row === undefined) return undefined;
    const method: TokenEndpointAuthMethod =
      row.token_endpoint_auth_method === 'client_secret_basic'
        ? 'client_secret_basic'
        : row.token_endpoint_auth_method === 'client_secret_post'
          ? 'client_secret_post'
          : 'none';
    return {
      clientId: row.client_id,
      kind: row.kind === 'cimd' ? 'cimd' : 'dcr',
      clientName: row.client_name,
      clientUri: row.client_uri,
      redirectUris: jsonList(row.redirect_uris),
      grantTypes: jsonList(row.grant_types),
      tokenEndpointAuthMethod: method,
      clientSecretHash: row.client_secret_hash,
      metadataFetchedAt: row.metadata_fetched_at,
      metadataExpiresAt: row.metadata_expires_at,
      createdAt: row.created_at,
    };
  }

  upsertClient(client: Omit<OAuthClientRow, 'createdAt'>, nowIso: string): void {
    this.db.run(
      `INSERT INTO mcp_oauth_clients
         (client_id, kind, client_name, client_uri, redirect_uris, grant_types, token_endpoint_auth_method,
          client_secret_hash, metadata_fetched_at, metadata_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         client_name = excluded.client_name, client_uri = excluded.client_uri,
         redirect_uris = excluded.redirect_uris, grant_types = excluded.grant_types,
         token_endpoint_auth_method = excluded.token_endpoint_auth_method,
         metadata_fetched_at = excluded.metadata_fetched_at, metadata_expires_at = excluded.metadata_expires_at`,
      [
        client.clientId,
        client.kind,
        client.clientName,
        client.clientUri,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.grantTypes),
        client.tokenEndpointAuthMethod,
        client.clientSecretHash,
        client.metadataFetchedAt,
        client.metadataExpiresAt,
        nowIso,
      ],
    );
  }

  countClientsCreatedSince(sinceIso: string): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM mcp_oauth_clients WHERE kind = 'dcr' AND created_at >= ?",
      [sinceIso],
    );
    return Number(row?.n ?? 0);
  }

  // -- authorization requests --------------------------------------------------

  createAuthorizationRequest(
    input: Omit<AuthorizationRequestRow, 'enrollmentId' | 'authenticatedAt' | 'completedAt'> & {
      readonly ip: string | null;
    },
  ): void {
    this.db.run(
      `INSERT INTO mcp_oauth_authorization_requests
         (id, csrf_token_hash, client_id, redirect_uri, state, code_challenge, requested_scopes, resource,
          connection_id, created_at, expires_at, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.csrfTokenHash,
        input.clientId,
        input.redirectUri,
        input.state,
        input.codeChallenge,
        input.requestedScopes === null ? null : JSON.stringify(input.requestedScopes),
        input.resource,
        input.connectionId,
        input.createdAt,
        input.expiresAt,
        input.ip,
      ],
    );
  }

  findAuthorizationRequest(id: string): AuthorizationRequestRow | undefined {
    const row = this.db.get<{
      id: string;
      csrf_token_hash: string;
      client_id: string;
      redirect_uri: string;
      state: string | null;
      code_challenge: string;
      requested_scopes: string | null;
      resource: string | null;
      connection_id: string | null;
      enrollment_id: string | null;
      authenticated_at: string | null;
      created_at: string;
      expires_at: string;
      completed_at: string | null;
    }>(
      `SELECT id, csrf_token_hash, client_id, redirect_uri, state, code_challenge, requested_scopes, resource,
              connection_id, enrollment_id, authenticated_at, created_at, expires_at, completed_at
         FROM mcp_oauth_authorization_requests WHERE id = ?`,
      [id],
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      csrfTokenHash: row.csrf_token_hash,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      state: row.state,
      codeChallenge: row.code_challenge,
      requestedScopes: row.requested_scopes === null ? null : parseScopes(row.requested_scopes),
      resource: row.resource,
      connectionId: row.connection_id,
      enrollmentId: row.enrollment_id,
      authenticatedAt: row.authenticated_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
    };
  }

  markRequestAuthenticated(
    id: string,
    connectionId: string,
    enrollmentId: string,
    nowIso: string,
  ): void {
    this.db.run(
      `UPDATE mcp_oauth_authorization_requests
          SET connection_id = ?, enrollment_id = ?, authenticated_at = ?
        WHERE id = ? AND completed_at IS NULL`,
      [connectionId, enrollmentId, nowIso, id],
    );
  }

  /** Single-winner completion of the browser transaction (approve or deny). */
  completeRequest(id: string, nowIso: string): boolean {
    const result = this.db.run(
      'UPDATE mcp_oauth_authorization_requests SET completed_at = ? WHERE id = ? AND completed_at IS NULL',
      [nowIso, id],
    );
    return Number(result.changes) === 1;
  }

  // -- codes -------------------------------------------------------------------

  createCode(
    input: Omit<AuthorizationCodeRow, 'redeemedAt' | 'grantId'> & { readonly codeHash: string },
  ): void {
    this.db.run(
      `INSERT INTO mcp_oauth_authorization_codes
         (id, code_hash, request_id, client_id, redirect_uri, code_challenge, scopes, resource, connection_id,
          enrollment_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.codeHash,
        input.requestId,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        JSON.stringify(input.scopes),
        input.resource,
        input.connectionId,
        input.enrollmentId,
        input.createdAt,
        input.expiresAt,
      ],
    );
  }

  findCodeByHash(codeHash: string): AuthorizationCodeRow | undefined {
    const row = this.db.get<{
      id: string;
      request_id: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      scopes: string;
      resource: string;
      connection_id: string;
      enrollment_id: string;
      created_at: string;
      expires_at: string;
      redeemed_at: string | null;
      grant_id: string | null;
    }>(
      `SELECT id, request_id, client_id, redirect_uri, code_challenge, scopes, resource, connection_id,
              enrollment_id, created_at, expires_at, redeemed_at, grant_id
         FROM mcp_oauth_authorization_codes WHERE code_hash = ?`,
      [codeHash],
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      requestId: row.request_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scopes: parseScopes(row.scopes),
      resource: row.resource,
      connectionId: row.connection_id,
      enrollmentId: row.enrollment_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      redeemedAt: row.redeemed_at,
      grantId: row.grant_id,
    };
  }

  /** Single-winner redemption. */
  redeemCode(id: string, nowIso: string): boolean {
    const result = this.db.run(
      'UPDATE mcp_oauth_authorization_codes SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL',
      [nowIso, id],
    );
    return Number(result.changes) === 1;
  }

  attachGrantToCode(id: string, grantId: string): void {
    this.db.run('UPDATE mcp_oauth_authorization_codes SET grant_id = ? WHERE id = ?', [
      grantId,
      id,
    ]);
  }

  // -- grants ------------------------------------------------------------------

  createGrant(
    input: Omit<GrantRow, 'id' | 'lastUsedAt' | 'revokedAt' | 'revokedReason'>,
  ): GrantRow {
    const id = generateRowId('gr');
    this.db.run(
      `INSERT INTO mcp_oauth_grants (id, connection_id, client_id, client_name, redirect_uri, scopes, resource, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.connectionId,
        input.clientId,
        input.clientName,
        input.redirectUri,
        JSON.stringify(input.scopes),
        input.resource,
        input.createdAt,
      ],
    );
    const grant = this.findGrant(id);
    if (grant === undefined) throw new Error('grant insert did not persist');
    return grant;
  }

  findGrant(id: string): GrantRow | undefined {
    const row = this.db.get<RawGrant>(
      `SELECT ${GRANT_COLUMNS} FROM mcp_oauth_grants WHERE id = ?`,
      [id],
    );
    return row === undefined ? undefined : toGrant(row);
  }

  listGrants(connectionId: string): GrantRow[] {
    return this.db
      .all<RawGrant>(
        `SELECT ${GRANT_COLUMNS} FROM mcp_oauth_grants WHERE connection_id = ? ORDER BY created_at DESC`,
        [connectionId],
      )
      .map(toGrant);
  }

  countActiveGrants(connectionId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM mcp_oauth_grants WHERE connection_id = ? AND revoked_at IS NULL',
      [connectionId],
    );
    return Number(row?.n ?? 0);
  }

  touchGrant(id: string, nowIso: string): void {
    this.db.run('UPDATE mcp_oauth_grants SET last_used_at = ? WHERE id = ?', [nowIso, id]);
  }

  /** Revokes a grant and every access/refresh token issued under it. */
  revokeGrant(id: string, reason: string, nowIso: string): boolean {
    let changed = false;
    this.db.transaction(() => {
      const result = this.db.run(
        'UPDATE mcp_oauth_grants SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
        [nowIso, reason, id],
      );
      changed = Number(result.changes) === 1;
      this.db.run(
        'UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL',
        [nowIso, id],
      );
      this.db.run(
        'UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL',
        [nowIso, id],
      );
    });
    return changed;
  }

  /** Revokes every grant (and so every token) of a connection. Returns the number revoked. */
  revokeAllGrantsForConnection(connectionId: string, reason: string, nowIso: string): number {
    let count = 0;
    for (const grant of this.listGrants(connectionId)) {
      if (grant.revokedAt === null && this.revokeGrant(grant.id, reason, nowIso)) count += 1;
    }
    return count;
  }

  // -- tokens ------------------------------------------------------------------

  createAccessToken(input: {
    readonly tokenHash: string;
    readonly grantId: string;
    readonly connectionId: string;
    readonly scopes: readonly McpScope[];
    readonly resource: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): void {
    this.db.run(
      `INSERT INTO mcp_oauth_access_tokens (id, token_hash, grant_id, connection_id, scopes, resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateRowId('at'),
        input.tokenHash,
        input.grantId,
        input.connectionId,
        JSON.stringify(input.scopes),
        input.resource,
        input.createdAt,
        input.expiresAt,
      ],
    );
  }

  findAccessTokenByHash(tokenHash: string): AccessTokenRow | undefined {
    const row = this.db.get<{
      id: string;
      grant_id: string;
      connection_id: string;
      scopes: string;
      resource: string;
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, grant_id, connection_id, scopes, resource, created_at, expires_at, revoked_at
         FROM mcp_oauth_access_tokens WHERE token_hash = ?`,
      [tokenHash],
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      grantId: row.grant_id,
      connectionId: row.connection_id,
      scopes: parseScopes(row.scopes),
      resource: row.resource,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  revokeAccessTokenByHash(tokenHash: string, nowIso: string): string | null {
    const token = this.findAccessTokenByHash(tokenHash);
    if (token === undefined) return null;
    this.db.run(
      'UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [nowIso, token.id],
    );
    return token.grantId;
  }

  createRefreshToken(input: {
    readonly tokenHash: string;
    readonly grantId: string;
    readonly parentId: string | null;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): string {
    const id = generateRowId('rt');
    this.db.run(
      `INSERT INTO mcp_oauth_refresh_tokens (id, token_hash, grant_id, parent_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.tokenHash, input.grantId, input.parentId, input.createdAt, input.expiresAt],
    );
    return id;
  }

  findRefreshTokenByHash(tokenHash: string): RefreshTokenRow | undefined {
    const row = this.db.get<{
      id: string;
      grant_id: string;
      parent_id: string | null;
      created_at: string;
      expires_at: string;
      used_at: string | null;
      revoked_at: string | null;
    }>(
      `SELECT id, grant_id, parent_id, created_at, expires_at, used_at, revoked_at
         FROM mcp_oauth_refresh_tokens WHERE token_hash = ?`,
      [tokenHash],
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      grantId: row.grant_id,
      parentId: row.parent_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
    };
  }

  /** Single-winner rotation: marks the presented refresh token used. */
  markRefreshTokenUsed(id: string, nowIso: string): boolean {
    const result = this.db.run(
      'UPDATE mcp_oauth_refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
      [nowIso, id],
    );
    return Number(result.changes) === 1;
  }

  // -- housekeeping ------------------------------------------------------------

  /** Removes artefacts that expired before `horizonIso` (they are already unusable). */
  purgeExpired(horizonIso: string): void {
    this.db.run('DELETE FROM mcp_oauth_authorization_requests WHERE expires_at < ?', [horizonIso]);
    this.db.run('DELETE FROM mcp_oauth_authorization_codes WHERE expires_at < ?', [horizonIso]);
    this.db.run('DELETE FROM mcp_oauth_access_tokens WHERE expires_at < ?', [horizonIso]);
    this.db.run('DELETE FROM mcp_oauth_refresh_tokens WHERE expires_at < ?', [horizonIso]);
    this.db.run('DELETE FROM mcp_login_attempts WHERE attempted_at < ?', [horizonIso]);
  }
}

interface RawGrant {
  id: string;
  connection_id: string;
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  scopes: string;
  resource: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

const GRANT_COLUMNS =
  'id, connection_id, client_id, client_name, redirect_uri, scopes, resource, created_at, last_used_at, revoked_at, revoked_reason';

function toGrant(row: RawGrant): GrantRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    scopes: parseScopes(row.scopes),
    resource: row.resource,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}
