/**
 * Resource-server side: turns `Authorization: Bearer …` on a request to
 * `/mcp/<connectionId>` into a server-side authorization context — or a
 * correctly-shaped refusal (RFC 6750 §3 / MCP 2026-07-28 §Error Handling).
 *
 * Checked on **every** request, in this order, all against the database:
 * service enabled → connection exists → token known, unexpired, unrevoked →
 * token issued for *this* connection (no cross-connection replay) → token
 * audience equals this connection's current resource URL → grant live →
 * connection usable (not disabled/expired/suspended) → effective scopes
 * non-empty. The mailbox the request may touch is read from the binding row
 * at the end of that chain; nothing the client sends can name it.
 *
 * Effective permissions = granted token scopes ∩ the connection's current
 * postmaster permissions ∩ currently available capabilities. Removing a
 * permission therefore takes effect on the next request, even for tokens
 * issued before the change.
 */
import { MCP_SCOPES, type McpScope } from '@dwg/shared';
import type { Clock } from '../platform/clock.js';
import { sha256Hex } from '../crypto/random.js';
import type { ConnectionsRepository } from '../store/connections.repository.js';
import type { OAuthRepository } from '../store/oauth.repository.js';
import type { SettingsRepository } from '../store/settings.repository.js';
import type { BindingsRepository } from '../store/bindings.repository.js';
import type { McpAuditLog } from '../domain/audit.js';
import type { ConnectionsService } from '../domain/connections.service.js';
import {
  bearerChallenge,
  CONNECTION_ID_PATTERN,
  resourceFor,
  resourceMetadataUrlFor,
} from './endpoints.js';

export interface McpAuthContext {
  readonly connectionId: string;
  readonly bindingId: string;
  /** The one mailbox this request may touch — from the binding row, never from the request. */
  readonly mailbox: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly scopes: readonly McpScope[];
  readonly senderIdentities: readonly string[];
}

export type BearerOutcome =
  | { readonly ok: true; readonly context: McpAuthContext }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 404 | 503;
      readonly challenge: string | null;
      readonly description: string;
    };

export interface BearerVerifierDeps {
  readonly settings: SettingsRepository;
  readonly connectionsRepo: ConnectionsRepository;
  readonly bindings: BindingsRepository;
  readonly oauth: OAuthRepository;
  readonly connections: ConnectionsService;
  readonly audit: McpAuditLog;
  readonly clock: Clock;
}

const TOUCH_INTERVAL_MS = 60_000;

export class BearerVerifier {
  constructor(private readonly deps: BearerVerifierDeps) {}

  /** Capabilities currently available on this server, independent of any one connection. */
  availableCapabilities(): McpScope[] {
    const settings = this.deps.settings.get();
    return MCP_SCOPES.filter((scope) =>
      scope === 'mail.send'
        ? settings.rateLimits.sendsPerHour > 0 && settings.rateLimits.sendsPerDay > 0
        : true,
    );
  }

  verify(
    connectionId: string,
    authorization: string | undefined,
    ip: string | null,
  ): BearerOutcome {
    const settings = this.deps.settings.get();
    if (!settings.enabled || settings.publicBaseUrl === null) {
      return {
        ok: false,
        status: 503,
        challenge: null,
        description: 'MCP access is disabled on this server.',
      };
    }
    const base = settings.publicBaseUrl;
    if (!CONNECTION_ID_PATTERN.test(connectionId)) {
      return { ok: false, status: 404, challenge: null, description: 'Unknown MCP endpoint.' };
    }
    const connection = this.deps.connectionsRepo.findById(connectionId);
    if (connection === undefined || connection.state === 'revoked') {
      return { ok: false, status: 404, challenge: null, description: 'Unknown MCP endpoint.' };
    }
    const resourceMetadata = resourceMetadataUrlFor(base, connectionId);
    const challenge401 = (description: string, error?: 'invalid_token' | 'invalid_request') =>
      ({
        ok: false,
        status: 401,
        challenge: bearerChallenge({
          resourceMetadata,
          scope: connection.scopes,
          error,
          description: error ? description : undefined,
        }),
        description,
      }) as const;

    if (authorization === undefined || authorization.length === 0) {
      return challenge401('Authorization required.');
    }
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(authorization.trim());
    if (match?.[1] === undefined) {
      return challenge401('Malformed Authorization header.', 'invalid_request');
    }
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    const token = this.deps.oauth.findAccessTokenByHash(sha256Hex(match[1]));
    if (token === undefined || token.revokedAt !== null || token.expiresAt <= nowIso) {
      return challenge401('The access token is invalid, expired or revoked.', 'invalid_token');
    }
    const deny = (reason: string, description: string): BearerOutcome => {
      this.deps.audit.record({
        event: 'access.denied',
        result: 'failure',
        actor: 'anonymous',
        connectionId,
        ip,
        details: { reason },
      });
      return challenge401(description, 'invalid_token');
    };
    // Cross-connection replay: a token for connection A presented at B's URL.
    if (token.connectionId !== connectionId) {
      return deny('audience_mismatch', 'The access token was not issued for this MCP endpoint.');
    }
    if (token.resource !== resourceFor(base, connectionId)) {
      return deny(
        'resource_mismatch',
        'The access token audience does not match this MCP endpoint.',
      );
    }
    const grant = this.deps.oauth.findGrant(token.grantId);
    if (grant === undefined || grant.revokedAt !== null || grant.connectionId !== connectionId) {
      return challenge401('The authorization grant has been revoked.', 'invalid_token');
    }
    const binding = this.deps.bindings.findById(connection.bindingId);
    if (binding === undefined) {
      return {
        ok: false,
        status: 403,
        challenge: null,
        description: 'This connection is not usable.',
      };
    }
    const { status, reason } = this.deps.connections.statusOf(connection, binding);
    if (status !== 'active') {
      // Disabled/expired/suspended: the token is genuine but access is refused.
      return {
        ok: false,
        status: 403,
        challenge: null,
        description: reason ?? `This connection is ${status}.`,
      };
    }
    const capabilities = this.availableCapabilities();
    const scopes = token.scopes.filter(
      (scope) => connection.scopes.includes(scope) && capabilities.includes(scope),
    );
    if (scopes.length === 0) {
      return {
        ok: false,
        status: 403,
        challenge: bearerChallenge({
          resourceMetadata,
          scope: connection.scopes,
          error: 'insufficient_scope',
          description: 'None of the granted permissions are currently allowed.',
        }),
        description: 'None of the granted permissions are currently allowed.',
      };
    }
    if (
      connection.lastUsedAt === null ||
      now.getTime() - Date.parse(connection.lastUsedAt) > TOUCH_INTERVAL_MS
    ) {
      this.deps.connectionsRepo.touchUsed(connectionId, nowIso);
      this.deps.oauth.touchGrant(grant.id, nowIso);
    }
    return {
      ok: true,
      context: {
        connectionId,
        bindingId: binding.id,
        mailbox: binding.mailbox,
        grantId: grant.id,
        clientId: grant.clientId,
        scopes,
        senderIdentities: connection.senderIdentities,
      },
    };
  }
}
