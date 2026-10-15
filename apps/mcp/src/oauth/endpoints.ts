/**
 * URL layout and discovery documents.
 *
 *   issuer                     = <publicBaseUrl>                    (no path — RFC 8414 §3)
 *   AS metadata                = <issuer>/.well-known/oauth-authorization-server
 *   authorization endpoint     = <issuer>/oauth/authorize
 *   token endpoint             = <issuer>/oauth/token
 *   registration endpoint      = <issuer>/oauth/register            (only while DCR is enabled)
 *   revocation endpoint        = <issuer>/oauth/revoke
 *   protected resource         = <issuer>/mcp/<connectionId>        (one per connection — RFC 8707 audience)
 *   resource metadata (PRM)    = <issuer>/.well-known/oauth-protected-resource/mcp/<connectionId>  (RFC 9728 §3.1)
 *
 * The issuer string is used verbatim in the AS metadata `issuer`, in every
 * PRM's `authorization_servers`, and in the RFC 9207 `iss` authorization
 * response parameter — byte-identical in all three, as ChatGPT requires.
 */
import { MCP_SCOPES, type McpScope, type McpSettings } from '@dwg/shared';

export const CONNECTION_ID_PATTERN = /^c[0-9a-z]{26}$/;

export const SCOPE_OFFLINE_ACCESS = 'offline_access';

export interface Endpoints {
  readonly issuer: string;
  readonly authorization: string;
  readonly token: string;
  readonly registration: string;
  readonly revocation: string;
}

export function endpointsFor(publicBaseUrl: string): Endpoints {
  return {
    issuer: publicBaseUrl,
    authorization: `${publicBaseUrl}/oauth/authorize`,
    token: `${publicBaseUrl}/oauth/token`,
    registration: `${publicBaseUrl}/oauth/register`,
    revocation: `${publicBaseUrl}/oauth/revoke`,
  };
}

export function resourceFor(publicBaseUrl: string, connectionId: string): string {
  return `${publicBaseUrl}/mcp/${connectionId}`;
}

export function resourceMetadataUrlFor(publicBaseUrl: string, connectionId: string): string {
  return `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp/${connectionId}`;
}

/**
 * Parses a client-supplied `resource` indicator and returns the connection
 * id it names — only if it is exactly one of this server's connection
 * resources. Scheme/host case and an explicit default port are tolerated
 * (MCP spec: "SHOULD accept uppercase scheme and host"); a trailing slash is
 * tolerated; anything with a query, fragment, userinfo, other host, or other
 * path is not a resource of this server.
 */
export function connectionIdFromResource(publicBaseUrl: string, resource: string): string | null {
  let candidate: URL;
  let base: URL;
  try {
    candidate = new URL(resource);
    base = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (
    candidate.search !== '' ||
    candidate.hash !== '' ||
    candidate.username !== '' ||
    candidate.password !== ''
  ) {
    return null;
  }
  // `URL` lower-cases scheme/host and drops default ports, so `.origin`
  // comparison is the normalised comparison.
  if (candidate.origin !== base.origin) return null;
  const match = /^\/mcp\/(c[0-9a-z]{26})\/?$/.exec(candidate.pathname);
  return match?.[1] ?? null;
}

export function buildAuthorizationServerMetadata(
  settings: McpSettings,
): Record<string, unknown> | null {
  if (settings.publicBaseUrl === null) return null;
  const endpoints = endpointsFor(settings.publicBaseUrl);
  return {
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorization,
    token_endpoint: endpoints.token,
    ...(settings.clientRegistration.dynamicRegistration
      ? { registration_endpoint: endpoints.registration }
      : {}),
    revocation_endpoint: endpoints.revocation,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: [
      'none',
      'client_secret_basic',
      'client_secret_post',
    ],
    scopes_supported: [...MCP_SCOPES, SCOPE_OFFLINE_ACCESS],
    client_id_metadata_document_supported: settings.clientRegistration.metadataDocuments,
    authorization_response_iss_parameter_supported: true,
    service_documentation:
      'https://github.com/ArvinRahnama/docker-webmail-gui/blob/main/docs/mcp-integration.md',
  };
}

/** RFC 9728 document for one connection; scopes are that connection's current permissions only. */
export function buildProtectedResourceMetadata(
  settings: McpSettings,
  connectionId: string,
  scopes: readonly McpScope[],
): Record<string, unknown> | null {
  if (settings.publicBaseUrl === null) return null;
  return {
    resource: resourceFor(settings.publicBaseUrl, connectionId),
    authorization_servers: [settings.publicBaseUrl],
    // offline_access is an AS concern, deliberately not listed here (MCP 2026-07-28 §Refresh Tokens).
    scopes_supported: [...scopes],
    bearer_methods_supported: ['header'],
    resource_name: 'Mailbox (docker-webmail-gui MCP)',
    resource_documentation:
      'https://github.com/ArvinRahnama/docker-webmail-gui/blob/main/docs/mcp-integration.md',
  };
}

/** Quoted-string escaping for WWW-Authenticate auth-params (RFC 9110 §5.6.4). */
function quote(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

export function bearerChallenge(params: {
  readonly resourceMetadata: string;
  readonly scope?: readonly string[] | undefined;
  readonly error?: 'invalid_token' | 'insufficient_scope' | 'invalid_request' | undefined;
  readonly description?: string | undefined;
}): string {
  const parts = [`resource_metadata=${quote(params.resourceMetadata)}`];
  if (params.scope !== undefined && params.scope.length > 0)
    parts.push(`scope=${quote(params.scope.join(' '))}`);
  if (params.error !== undefined) parts.push(`error=${quote(params.error)}`);
  if (params.description !== undefined)
    parts.push(`error_description=${quote(params.description)}`);
  return `Bearer ${parts.join(', ')}`;
}
