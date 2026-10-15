/**
 * Protocol conformance against the official MCP TypeScript client SDK
 * (`@modelcontextprotocol/client`), over real HTTP. The SDK performs its own
 * 401 → protected-resource-metadata → authorization-server-metadata
 * discovery, client registration (Client ID Metadata Document or Dynamic
 * Client Registration), PKCE, RFC 9207 `iss` validation and token exchange;
 * this test plays only the human in the browser, using the hosted sign-in
 * page exactly as served.
 *
 * This is the closest available stand-in for ChatGPT in an automated test.
 * It does not prove ChatGPT compatibility by itself — see
 * docs/mcp-integration.md §Verification status.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import {
  createConnection,
  createHarness,
  type CreatedConnection,
  type Harness,
} from './mcp-test-harness.js';

const REDIRECT = 'http://127.0.0.1:47123/callback';
const CIMD_URL = 'https://client.example.test/oauth/client-metadata.json';

class MemoryProvider implements OAuthClientProvider {
  private info: unknown;
  private stored: unknown;
  private verifier = '';
  authorizationUrl: URL | null = null;
  readonly clientMetadataUrl?: string;
  constructor(useCimd: boolean) {
    if (useCimd) this.clientMetadataUrl = CIMD_URL;
  }
  get redirectUrl(): string {
    return REDIRECT;
  }
  get clientMetadata() {
    return {
      client_name: 'MCP SDK conformance client',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info as never;
  }
  saveClientInformation(info: unknown): void {
    this.info = info;
  }
  tokens() {
    return this.stored as never;
  }
  saveTokens(tokens: unknown): void {
    this.stored = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }
  codeVerifier(): string {
    return this.verifier;
  }
}

/** The human in the browser: load the sign-in page, sign in, approve; return the callback URL. */
async function actAsUser(authorizationUrl: URL, connection: CreatedConnection): Promise<URL> {
  const start = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(start.status).toBe(200);
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const page = await start.text();
  const txn = /name="txn" value="([^"]+)"/.exec(page)?.[1] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
  const origin = authorizationUrl.origin;
  const post = (path: string, fields: Record<string, string>) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin },
      body: new URLSearchParams(fields).toString(),
    });
  const login = await post('/oauth/authorize/login', {
    txn,
    csrf,
    username: connection.username,
    password: connection.setupPassword,
  });
  const consent = await login.text();
  expect(consent).toContain('name="decision"');
  const decision = await post('/oauth/authorize/decision', { txn, csrf, decision: 'approve' });
  expect(decision.status).toBe(303);
  return new URL(decision.headers.get('location') ?? '');
}

let h: Harness;
let base: string;
beforeEach(async () => {
  h = await createHarness({
    fetcher: async (url) => {
      expect(url.toString()).toBe(CIMD_URL);
      return {
        json: {
          client_id: CIMD_URL,
          client_name: 'MCP SDK conformance client (CIMD)',
          redirect_uris: [REDIRECT],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        maxAgeSeconds: 300,
      };
    },
  });
  await h.publicApp.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.publicApp.server.address() as AddressInfo).port}`;
  h.services.settings.update({ publicBaseUrl: base }, h.clock.now().toISOString());
});
afterEach(async () => {
  await h.close();
});

describe.each([
  ['Dynamic Client Registration', false],
  ['Client ID Metadata Document', true],
])('official MCP client SDK via %s', (_label, useCimd) => {
  it('discovers, authorizes with the setup credential, and calls tools', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const mcpUrl = new URL(`${base}/mcp/${connection.id}`);
    const provider = new MemoryProvider(useCimd);

    const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    const client = new Client({ name: 'conformance', version: '1.0.0' });
    await expect(client.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    const authorizationUrl = provider.authorizationUrl;
    expect(authorizationUrl).not.toBeNull();
    expect(authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl!.searchParams.get('resource')).toBe(mcpUrl.toString());
    expect(authorizationUrl!.searchParams.get('client_id')).toEqual(
      useCimd ? CIMD_URL : expect.stringMatching(/^dcr_/),
    );

    const callback = await actAsUser(authorizationUrl!, connection);
    await first.finishAuth(callback.searchParams);

    const second = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    const authed = new Client({ name: 'conformance', version: '1.0.0' });
    await authed.connect(second);
    const tools = await authed.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('mail_list_messages');
    const result = await authed.callTool({
      name: 'mail_list_messages',
      arguments: { folder: 'INBOX', limit: 5 },
    });
    expect(JSON.stringify(result)).toContain('Welcome to sales@example.test');
    await authed.close();
  });
});
