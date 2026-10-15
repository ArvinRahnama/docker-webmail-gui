/**
 * Authorization codes, access tokens and refresh tokens.
 *
 *  - Codes: 256-bit, single use, 60 s lifetime, bound to client, redirect
 *    URI, PKCE challenge (S256 only), scopes, resource and the exact
 *    enrollment that authenticated. Presenting a redeemed code again revokes
 *    the grant it produced (OAuth 2.1 §4.1.3).
 *  - Access tokens: opaque, short-lived (settings: 5–60 min), stored hashed,
 *    bound to one grant → one connection → one mailbox, and to that
 *    connection's resource URL as audience.
 *  - Refresh tokens: rotated on every use; presenting an already-rotated
 *    token is treated as theft and revokes the whole grant (OAuth 2.1
 *    §4.3.1, MCP §Token Theft). Rotation is single-winner, so concurrent
 *    refreshes with one token cannot both succeed.
 *
 * Because tokens are opaque and looked up on every request, revoking a grant,
 * disabling a connection or removing a permission takes effect on the very
 * next request — there is no self-contained token that outlives a revocation.
 */
import { createHash } from 'node:crypto';
import { MCP_SCOPES, type McpScope } from '@dwg/shared';
import type { Clock } from '../platform/clock.js';
import { addSeconds } from '../platform/clock.js';
import { OAuthError } from '../platform/errors.js';
import { generateOpaqueToken, generateRowId, sha256Hex } from '../crypto/random.js';
import type { OAuthClientRow, OAuthRepository } from '../store/oauth.repository.js';
import type { ConnectionsRepository } from '../store/connections.repository.js';
import type { SettingsRepository } from '../store/settings.repository.js';
import type { McpAuditLog } from '../domain/audit.js';
import type { ConnectionsService } from '../domain/connections.service.js';
import { resourceFor } from './endpoints.js';

export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export interface TokensServiceDeps {
  readonly repo: OAuthRepository;
  readonly connectionsRepo: ConnectionsRepository;
  readonly connections: ConnectionsService;
  readonly settings: SettingsRepository;
  readonly audit: McpAuditLog;
  readonly clock: Clock;
}

/** RFC 7636 §4.6: BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return computed.length === challenge.length && computed === challenge;
}

export function parseScopeParam(raw: string | undefined): { mail: McpScope[]; offline: boolean } {
  const tokens = (raw ?? '').split(' ').filter((token) => token.length > 0);
  return {
    mail: MCP_SCOPES.filter((scope) => tokens.includes(scope)),
    offline: tokens.includes('offline_access'),
  };
}

export class TokensService {
  constructor(private readonly deps: TokensServiceDeps) {}

  /** Mints a code for an approved, authenticated authorization request. Returns the plaintext code. */
  issueCode(input: {
    readonly requestId: string;
    readonly client: OAuthClientRow;
    readonly redirectUri: string;
    readonly codeChallenge: string;
    readonly scopes: readonly McpScope[];
    readonly resource: string;
    readonly connectionId: string;
    readonly enrollmentId: string;
  }): { code: string; codeId: string; expiresAt: string } {
    const now = this.deps.clock.now();
    const code = generateOpaqueToken('mcp_ac');
    const codeId = generateRowId('ac');
    const expiresAt = addSeconds(now, AUTHORIZATION_CODE_TTL_SECONDS).toISOString();
    this.deps.repo.createCode({
      id: codeId,
      codeHash: sha256Hex(code),
      requestId: input.requestId,
      clientId: input.client.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      resource: input.resource,
      connectionId: input.connectionId,
      enrollmentId: input.enrollmentId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return { code, codeId, expiresAt };
  }

  private mintPair(
    grantId: string,
    connectionId: string,
    scopes: readonly McpScope[],
    resource: string,
    parentRefreshId: string | null,
  ): TokenResponse {
    const settings = this.deps.settings.get();
    const now = this.deps.clock.now();
    const accessToken = generateOpaqueToken('mcp_at');
    const refreshToken = generateOpaqueToken('mcp_rt');
    const accessTtl = settings.accessTokenTtlMinutes * 60;
    this.deps.repo.createAccessToken({
      tokenHash: sha256Hex(accessToken),
      grantId,
      connectionId,
      scopes,
      resource,
      createdAt: now.toISOString(),
      expiresAt: addSeconds(now, accessTtl).toISOString(),
    });
    this.deps.repo.createRefreshToken({
      tokenHash: sha256Hex(refreshToken),
      grantId,
      parentId: parentRefreshId,
      createdAt: now.toISOString(),
      expiresAt: addSeconds(now, settings.refreshTokenTtlDays * 86_400).toISOString(),
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  /** Throws `invalid_grant` unless the connection can currently be used. */
  private assertConnectionUsable(connectionId: string): void {
    const settings = this.deps.settings.get();
    if (!settings.enabled)
      throw new OAuthError('invalid_grant', 'MCP access is currently disabled on this server.');
    const connection = this.deps.connectionsRepo.findById(connectionId);
    if (connection === undefined)
      throw new OAuthError('invalid_grant', 'The connection no longer exists.');
    const summary = this.deps.connections.toSummary(connection);
    if (summary.status !== 'active' && summary.status !== 'pending') {
      throw new OAuthError('invalid_grant', `The connection is ${summary.status}.`);
    }
  }

  async exchangeCode(input: {
    readonly client: OAuthClientRow;
    readonly code: string | undefined;
    readonly redirectUri: string | undefined;
    readonly codeVerifier: string | undefined;
    readonly resource: string | undefined;
    readonly ip: string | null;
  }): Promise<TokenResponse> {
    if (input.code === undefined || input.codeVerifier === undefined) {
      throw new OAuthError('invalid_request', 'code and code_verifier are required.');
    }
    if (!input.client.grantTypes.includes('authorization_code')) {
      throw new OAuthError(
        'unauthorized_client',
        'This client may not use the authorization_code grant.',
      );
    }
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    const code = this.deps.repo.findCodeByHash(sha256Hex(input.code));
    if (code === undefined)
      throw new OAuthError('invalid_grant', 'The authorization code is invalid.');

    if (code.redeemedAt !== null) {
      // Replay of a used code: revoke whatever it produced.
      if (code.grantId !== null)
        this.deps.repo.revokeGrant(code.grantId, 'authorization code replayed', nowIso);
      this.deps.audit.record({
        event: 'oauth.code_replay_detected',
        result: 'failure',
        actor: `client:${input.client.clientId}`,
        connectionId: code.connectionId,
        ip: input.ip,
      });
      throw new OAuthError('invalid_grant', 'The authorization code has already been used.');
    }
    if (code.clientId !== input.client.clientId)
      throw new OAuthError('invalid_grant', 'The authorization code was issued to another client.');
    if (code.expiresAt <= nowIso)
      throw new OAuthError('invalid_grant', 'The authorization code has expired.');
    // OAuth 2.1 §4.1.3: redirect_uri must match when it was present in the request (it always is here).
    if (input.redirectUri !== code.redirectUri)
      throw new OAuthError('invalid_grant', 'redirect_uri does not match.');
    if (!verifyPkceS256(input.codeVerifier, code.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    }
    // RFC 8707: a resource on the token request must name the same resource the code was issued for.
    if (
      input.resource !== undefined &&
      input.resource !== code.resource &&
      input.resource.replace(/\/$/, '') !== code.resource
    ) {
      throw new OAuthError('invalid_target', 'The resource does not match the authorization.');
    }
    if (!this.deps.repo.redeemCode(code.id, nowIso)) {
      throw new OAuthError('invalid_grant', 'The authorization code has already been used.');
    }
    // The setup password is consumed now, exactly once, by the code its
    // approval reserved. A reissue or revocation since then makes this fail.
    if (!this.deps.connectionsRepo.consumeEnrollment(code.enrollmentId, code.id, nowIso)) {
      throw new OAuthError(
        'invalid_grant',
        'The setup credential behind this authorization is no longer valid.',
      );
    }
    this.assertConnectionUsable(code.connectionId);
    const connection = this.deps.connectionsRepo.findById(code.connectionId);
    if (connection === undefined)
      throw new OAuthError('invalid_grant', 'The connection no longer exists.');
    const scopes = code.scopes.filter((scope) => connection.scopes.includes(scope));
    if (scopes.length === 0)
      throw new OAuthError(
        'invalid_scope',
        'None of the authorized permissions are still allowed.',
      );

    const grant = this.deps.repo.createGrant({
      connectionId: code.connectionId,
      clientId: input.client.clientId,
      clientName: input.client.clientName,
      redirectUri: code.redirectUri,
      scopes,
      resource: code.resource,
      createdAt: nowIso,
    });
    this.deps.repo.attachGrantToCode(code.id, grant.id);
    this.deps.connectionsRepo.touchAuthorized(code.connectionId, nowIso);
    const pair = this.mintPair(grant.id, code.connectionId, scopes, code.resource, null);
    this.deps.audit.record({
      event: 'enrollment.consumed',
      result: 'success',
      actor: `client:${input.client.clientId}`,
      connectionId: code.connectionId,
      mailbox: connection.mailbox,
      ip: input.ip,
    });
    this.deps.audit.record({
      event: 'oauth.token_issued',
      result: 'success',
      actor: `client:${input.client.clientId}`,
      connectionId: code.connectionId,
      mailbox: connection.mailbox,
      ip: input.ip,
      details: { grantId: grant.id, scopes: scopes.join(' ') },
    });
    return pair;
  }

  async refresh(input: {
    readonly client: OAuthClientRow;
    readonly refreshToken: string | undefined;
    readonly scope: string | undefined;
    readonly resource: string | undefined;
    readonly ip: string | null;
  }): Promise<TokenResponse> {
    if (input.refreshToken === undefined)
      throw new OAuthError('invalid_request', 'refresh_token is required.');
    const nowIso = this.deps.clock.now().toISOString();
    const token = this.deps.repo.findRefreshTokenByHash(sha256Hex(input.refreshToken));
    if (token === undefined) throw new OAuthError('invalid_grant', 'The refresh token is invalid.');
    const grant = this.deps.repo.findGrant(token.grantId);
    if (grant === undefined || grant.clientId !== input.client.clientId) {
      throw new OAuthError('invalid_grant', 'The refresh token is invalid.');
    }
    if (token.usedAt !== null) {
      // Reuse of a rotated refresh token ⇒ assume theft; kill the family.
      this.deps.repo.revokeGrant(grant.id, 'refresh token replay detected', nowIso);
      this.deps.audit.record({
        event: 'oauth.refresh_replay_detected',
        result: 'failure',
        actor: `client:${input.client.clientId}`,
        connectionId: grant.connectionId,
        ip: input.ip,
        details: { grantId: grant.id },
      });
      throw new OAuthError('invalid_grant', 'The refresh token has already been used.');
    }
    if (token.revokedAt !== null || grant.revokedAt !== null)
      throw new OAuthError('invalid_grant', 'The refresh token has been revoked.');
    if (token.expiresAt <= nowIso)
      throw new OAuthError('invalid_grant', 'The refresh token has expired.');
    if (input.resource !== undefined && input.resource.replace(/\/$/, '') !== grant.resource) {
      throw new OAuthError('invalid_target', 'The resource does not match the grant.');
    }
    const connection = this.deps.connectionsRepo.findById(grant.connectionId);
    const settings = this.deps.settings.get();
    if (
      connection === undefined ||
      settings.publicBaseUrl === null ||
      resourceFor(settings.publicBaseUrl, connection.id) !== grant.resource
    ) {
      // The public URL changed since the grant: its audience is gone.
      throw new OAuthError('invalid_grant', 'The grant is no longer valid for this server.');
    }
    this.assertConnectionUsable(grant.connectionId);

    let scopes = grant.scopes.filter((scope) => connection.scopes.includes(scope));
    if (input.scope !== undefined) {
      const requested = parseScopeParam(input.scope).mail;
      if (requested.some((scope) => !grant.scopes.includes(scope))) {
        throw new OAuthError('invalid_scope', 'A refresh cannot add permissions to a grant.');
      }
      scopes = scopes.filter((scope) => requested.includes(scope));
    }
    if (scopes.length === 0)
      throw new OAuthError('invalid_scope', 'No permissions remain for this grant.');

    if (!this.deps.repo.markRefreshTokenUsed(token.id, nowIso)) {
      // Lost a race with a concurrent refresh using the same token — same treatment as replay.
      this.deps.repo.revokeGrant(grant.id, 'concurrent refresh token reuse', nowIso);
      this.deps.audit.record({
        event: 'oauth.refresh_replay_detected',
        result: 'failure',
        actor: `client:${input.client.clientId}`,
        connectionId: grant.connectionId,
        ip: input.ip,
        details: { grantId: grant.id, concurrent: true },
      });
      throw new OAuthError('invalid_grant', 'The refresh token has already been used.');
    }
    this.deps.repo.touchGrant(grant.id, nowIso);
    const pair = this.mintPair(grant.id, grant.connectionId, scopes, grant.resource, token.id);
    this.deps.audit.record({
      event: 'oauth.token_refreshed',
      result: 'success',
      actor: `client:${input.client.clientId}`,
      connectionId: grant.connectionId,
      mailbox: connection.mailbox,
      ip: input.ip,
      details: { grantId: grant.id },
    });
    return pair;
  }

  /**
   * RFC 7009. Revoking a refresh token revokes the whole grant (and so its
   * access tokens); revoking an access token revokes that token. A token
   * belonging to another client is silently ignored (the response is the
   * same 200 either way, per §2.2).
   */
  revoke(input: {
    readonly client: OAuthClientRow;
    readonly token: string;
    readonly hint: string | undefined;
    readonly ip: string | null;
  }): void {
    const nowIso = this.deps.clock.now().toISOString();
    const hash = sha256Hex(input.token);
    const tryRefresh = (): boolean => {
      const refresh = this.deps.repo.findRefreshTokenByHash(hash);
      if (refresh === undefined) return false;
      const grant = this.deps.repo.findGrant(refresh.grantId);
      if (grant !== undefined && grant.clientId === input.client.clientId) {
        this.deps.repo.revokeGrant(grant.id, 'revoked by client', nowIso);
        this.deps.audit.record({
          event: 'oauth.token_revoked',
          result: 'success',
          actor: `client:${input.client.clientId}`,
          connectionId: grant.connectionId,
          ip: input.ip,
          details: { kind: 'refresh_token', grantId: grant.id },
        });
      }
      return true;
    };
    const tryAccess = (): boolean => {
      const access = this.deps.repo.findAccessTokenByHash(hash);
      if (access === undefined) return false;
      const grant = this.deps.repo.findGrant(access.grantId);
      if (grant !== undefined && grant.clientId === input.client.clientId) {
        this.deps.repo.revokeAccessTokenByHash(hash, nowIso);
        this.deps.audit.record({
          event: 'oauth.token_revoked',
          result: 'success',
          actor: `client:${input.client.clientId}`,
          connectionId: grant.connectionId,
          ip: input.ip,
          details: { kind: 'access_token' },
        });
      }
      return true;
    };
    if (input.hint === 'access_token') {
      if (!tryAccess()) tryRefresh();
    } else if (!tryRefresh()) {
      tryAccess();
    }
  }
}
