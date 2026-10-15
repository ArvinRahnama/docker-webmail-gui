/**
 * OAuth client identity: Client ID Metadata Documents (the MCP 2026-07-28
 * default), Dynamic Client Registration (RFC 7591, kept for compatibility),
 * redirect-URI validation and token-endpoint client authentication.
 *
 * A client — however it registered — is only ever a *requester*. Nothing in
 * client metadata selects a mailbox or a connection: the connection comes
 * from the validated `resource` indicator and the postmaster-issued setup
 * credential the user types in (docs/mcp-integration.md §OAuth).
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../platform/clock.js';
import { addSeconds } from '../platform/clock.js';
import { OAuthError } from '../platform/errors.js';
import { sha256Hex, timingSafeEqualString } from '../crypto/random.js';
import type {
  OAuthClientRow,
  OAuthRepository,
  TokenEndpointAuthMethod,
} from '../store/oauth.repository.js';
import type { SettingsRepository } from '../store/settings.repository.js';
import type { McpAuditLog } from '../domain/audit.js';
import { SafeFetchError, type MetadataFetcher } from './safe-fetch.js';

const MAX_REDIRECT_URIS = 10;
const CIMD_DEFAULT_TTL_SECONDS = 3600;
const CIMD_MAX_TTL_SECONDS = 86_400;
const CIMD_MIN_TTL_SECONDS = 60;

/** Loopback redirect hosts allowed over plain http (native/CLI clients — OAuth 2.1 §7.5.1 / RFC 8252). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** MCP 2026-07-28 §Communication Security: redirect URIs MUST be localhost or HTTPS; no fragments, no userinfo. */
export function validateRedirectUri(raw: string): string | null {
  if (raw.length > 2000) return 'redirect URI is too long';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'redirect URI is not an absolute URI';
  }
  if (url.hash !== '') return 'redirect URI must not contain a fragment';
  if (url.username !== '' || url.password !== '')
    return 'redirect URI must not contain credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return 'redirect URI must use https (or http on a loopback host)';
}

const RegistrationRequestSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  client_name: z.string().trim().min(1).max(100).optional(),
  client_uri: z.string().max(2000).optional(),
  grant_types: z.array(z.string()).max(5).optional(),
  response_types: z.array(z.string()).max(5).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().max(500).optional(),
  application_type: z.string().max(20).optional(),
});

const CimdDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(200),
  client_uri: z.string().max(2000).optional(),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  grant_types: z.array(z.string()).max(5).optional(),
  response_types: z.array(z.string()).max(5).optional(),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).max(10).optional(),
});

export interface ClientsServiceDeps {
  readonly repo: OAuthRepository;
  readonly settings: SettingsRepository;
  readonly fetcher: MetadataFetcher;
  readonly audit: McpAuditLog;
  readonly clock: Clock;
}

/** Hard ceiling on DCR registrations per rolling 24h — bounds table growth from an abusive client. */
const DCR_DAILY_CAP = 500;

export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

export class ClientsService {
  constructor(private readonly deps: ClientsServiceDeps) {}

  /** RFC 7591 registration. Returns the response body (201). */
  register(body: unknown, ip: string | null): Record<string, unknown> {
    const settings = this.deps.settings.get();
    if (!settings.clientRegistration.dynamicRegistration) {
      throw new OAuthError(
        'invalid_request',
        'Dynamic client registration is disabled on this server.',
        403,
      );
    }
    const now = this.deps.clock.now();
    if (
      this.deps.repo.countClientsCreatedSince(addSeconds(now, -86_400).toISOString()) >=
      DCR_DAILY_CAP
    ) {
      throw new OAuthError(
        'temporarily_unavailable',
        'Too many client registrations; try again later.',
        429,
      );
    }
    const parsed = RegistrationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthError('invalid_client_metadata', 'The client metadata is invalid.');
    }
    const request = parsed.data;
    for (const uri of request.redirect_uris) {
      const problem = validateRedirectUri(uri);
      if (problem !== null) throw new OAuthError('invalid_redirect_uri', problem);
    }
    const grantTypes = request.grant_types ?? ['authorization_code', 'refresh_token'];
    if (
      !grantTypes.includes('authorization_code') ||
      grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'Only the authorization_code and refresh_token grant types are supported.',
      );
    }
    if (request.response_types !== undefined && request.response_types.some((r) => r !== 'code')) {
      throw new OAuthError(
        'invalid_client_metadata',
        'Only the "code" response type is supported.',
      );
    }
    // RFC 7591 §2: the default is client_secret_basic.
    const method = (request.token_endpoint_auth_method ??
      'client_secret_basic') as TokenEndpointAuthMethod;
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) {
      throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
    }
    const clientId = `dcr_${randomBytes(16).toString('base64url')}`;
    const clientSecret =
      method === 'none' ? null : `mcp_cs_${randomBytes(32).toString('base64url')}`;
    this.deps.repo.upsertClient(
      {
        clientId,
        kind: 'dcr',
        clientName: request.client_name ?? null,
        clientUri: request.client_uri ?? null,
        redirectUris: request.redirect_uris,
        grantTypes,
        tokenEndpointAuthMethod: method,
        clientSecretHash: clientSecret === null ? null : sha256Hex(clientSecret),
        metadataFetchedAt: null,
        metadataExpiresAt: null,
      },
      now.toISOString(),
    );
    this.deps.audit.record({
      event: 'oauth.client_registered',
      result: 'success',
      actor: 'anonymous',
      ip,
      details: { clientId, clientName: request.client_name ?? null, authMethod: method },
    });
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      ...(clientSecret !== null
        ? { client_secret: clientSecret, client_secret_expires_at: 0 }
        : {}),
      client_name: request.client_name,
      client_uri: request.client_uri,
      redirect_uris: request.redirect_uris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: method,
    };
  }

  /**
   * Resolves a `client_id` to a client: a DCR-registered row, or a Client
   * ID Metadata Document fetched (SSRF-guarded) and cached.
   */
  async resolve(clientId: string, ip: string | null): Promise<OAuthClientRow> {
    if (clientId.length === 0 || clientId.length > 2000) {
      throw new OAuthError('invalid_client', 'Unknown client.', 401);
    }
    if (!isMetadataDocumentClientId(clientId)) {
      const client = this.deps.repo.findClient(clientId);
      if (client === undefined || client.kind !== 'dcr') {
        throw new OAuthError('invalid_client', 'Unknown client.', 401);
      }
      return client;
    }
    const settings = this.deps.settings.get();
    if (!settings.clientRegistration.metadataDocuments) {
      throw new OAuthError(
        'invalid_client',
        'Client ID Metadata Documents are disabled on this server.',
        401,
      );
    }
    const now = this.deps.clock.now();
    const cached = this.deps.repo.findClient(clientId);
    if (
      cached !== undefined &&
      cached.kind === 'cimd' &&
      cached.metadataExpiresAt !== null &&
      cached.metadataExpiresAt > now.toISOString()
    ) {
      return cached;
    }
    return this.fetchMetadataDocument(
      clientId,
      settings.clientRegistration.allowedMetadataHosts,
      ip,
    );
  }

  private async fetchMetadataDocument(
    clientId: string,
    allowedHosts: readonly string[],
    ip: string | null,
  ): Promise<OAuthClientRow> {
    const reject = (reason: string): never => {
      this.deps.audit.record({
        event: 'oauth.client_metadata_rejected',
        result: 'failure',
        actor: 'anonymous',
        ip,
        details: { clientId, reason },
      });
      throw new OAuthError(
        'invalid_client',
        `The client metadata document was rejected: ${reason}`,
        401,
      );
    };
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return reject('client_id is not a URL');
    }
    if (url.pathname === '/' || url.pathname === '')
      return reject('client_id URL must contain a path');
    if (url.search !== '') return reject('client_id URL must not contain a query');
    if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname.toLowerCase())) {
      return reject('the host is not on this server’s trusted metadata host list');
    }
    let fetched;
    try {
      fetched = await this.deps.fetcher(url);
    } catch (err) {
      return reject(err instanceof SafeFetchError ? err.message : 'fetch failed');
    }
    const parsed = CimdDocumentSchema.safeParse(fetched.json);
    if (!parsed.success) return reject('the document is missing required fields');
    const doc = parsed.data;
    if (doc.client_id !== clientId)
      return reject('client_id in the document does not match its URL');
    for (const uri of doc.redirect_uris) {
      if (validateRedirectUri(uri) !== null) return reject('a redirect URI is not https/loopback');
    }
    const methods = new Set([
      ...(doc.token_endpoint_auth_methods_supported ?? []),
      ...(doc.token_endpoint_auth_method !== undefined ? [doc.token_endpoint_auth_method] : []),
    ]);
    // Metadata-document clients are public clients here (PKCE, no secret);
    // a document that cannot use `none` is not one we can serve.
    if (methods.size > 0 && !methods.has('none')) {
      return reject('the client does not support token_endpoint_auth_method "none"');
    }
    const grantTypes = doc.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!grantTypes.includes('authorization_code'))
      return reject('authorization_code grant not listed');
    const ttl = Math.min(
      CIMD_MAX_TTL_SECONDS,
      Math.max(CIMD_MIN_TTL_SECONDS, fetched.maxAgeSeconds ?? CIMD_DEFAULT_TTL_SECONDS),
    );
    const now = this.deps.clock.now();
    const client: Omit<OAuthClientRow, 'createdAt'> = {
      clientId,
      kind: 'cimd',
      clientName: doc.client_name,
      clientUri: doc.client_uri ?? null,
      redirectUris: doc.redirect_uris,
      grantTypes,
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
      metadataFetchedAt: now.toISOString(),
      metadataExpiresAt: addSeconds(now, ttl).toISOString(),
    };
    this.deps.repo.upsertClient(client, now.toISOString());
    const stored = this.deps.repo.findClient(clientId);
    if (stored === undefined)
      throw new OAuthError('server_error', 'Client metadata could not be stored.', 500);
    return stored;
  }

  /** Exact-match redirect URI selection (OAuth 2.1 §2.3.1 / MCP §Open Redirection). */
  selectRedirectUri(client: OAuthClientRow, requested: string | undefined): string | null {
    if (requested === undefined) {
      return client.redirectUris.length === 1 ? (client.redirectUris[0] ?? null) : null;
    }
    return client.redirectUris.includes(requested) ? requested : null;
  }

  /**
   * Token/revocation endpoint client authentication. Returns the client, or
   * throws `invalid_client` (401) — uniformly, whether the client is unknown
   * or the secret is wrong.
   */
  async authenticate(input: {
    readonly authorizationHeader: string | undefined;
    readonly bodyClientId: string | undefined;
    readonly bodyClientSecret: string | undefined;
    readonly ip: string | null;
  }): Promise<OAuthClientRow> {
    let clientId = input.bodyClientId;
    let secret: string | undefined;
    let viaBasic = false;
    if (
      input.authorizationHeader !== undefined &&
      input.authorizationHeader.toLowerCase().startsWith('basic ')
    ) {
      const decoded = Buffer.from(input.authorizationHeader.slice(6).trim(), 'base64').toString(
        'utf8',
      );
      const separator = decoded.indexOf(':');
      if (separator < 0)
        throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
      const basicId = decodeURIComponent(decoded.slice(0, separator));
      if (clientId !== undefined && clientId !== basicId) {
        throw new OAuthError(
          'invalid_request',
          'client_id does not match the Authorization header.',
        );
      }
      clientId = basicId;
      secret = decodeURIComponent(decoded.slice(separator + 1));
      viaBasic = true;
    } else if (input.bodyClientSecret !== undefined) {
      secret = input.bodyClientSecret;
    }
    if (clientId === undefined)
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    let client: OAuthClientRow;
    try {
      client = await this.resolve(clientId, input.ip);
    } catch {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }
    switch (client.tokenEndpointAuthMethod) {
      case 'none':
        if (secret !== undefined)
          throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
        return client;
      case 'client_secret_basic':
      case 'client_secret_post': {
        const expectedBasic = client.tokenEndpointAuthMethod === 'client_secret_basic';
        if (
          secret === undefined ||
          client.clientSecretHash === null ||
          viaBasic !== expectedBasic
        ) {
          throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
        }
        if (!timingSafeEqualString(sha256Hex(secret), client.clientSecretHash)) {
          throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
        }
        return client;
      }
    }
  }
}
