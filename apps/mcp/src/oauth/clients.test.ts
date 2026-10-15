/**
 * Client identity: Client ID Metadata Documents (what ChatGPT uses) and
 * Dynamic Client Registration, plus redirect-URI rules.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorize,
  createConnection,
  createHarness,
  exchangeCode,
  pkcePair,
  type Harness,
} from '../mcp-test-harness.js';
import type { MetadataFetcher } from './safe-fetch.js';
import { validateRedirectUri } from './clients.service.js';

const CHATGPT_CLIENT = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

function documentFetcher(document: Record<string, unknown>, calls: string[] = []): MetadataFetcher {
  return async (url) => {
    calls.push(url.toString());
    return { json: document, maxAgeSeconds: 600 };
  };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('redirect URI rules', () => {
  it('accepts https and loopback http only, never fragments or credentials', () => {
    expect(validateRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect')).toBeNull();
    expect(validateRedirectUri('http://127.0.0.1:33418/callback')).toBeNull();
    expect(validateRedirectUri('http://localhost/cb')).toBeNull();
    expect(validateRedirectUri('http://evil.example/cb')).not.toBeNull();
    expect(validateRedirectUri('https://a.example/cb#frag')).not.toBeNull();
    expect(validateRedirectUri('https://u:p@a.example/cb')).not.toBeNull();
    expect(validateRedirectUri('javascript:alert(1)')).not.toBeNull();
  });
});

describe('Client ID Metadata Documents', () => {
  it('completes the full flow for a ChatGPT-style public CIMD client and caches the document', async () => {
    const calls: string[] = [];
    h = await createHarness({
      // Verbatim as published at https://chatgpt.com/oauth/client.json
      // (fetched 2026-10-15). Its preferred method is private_key_jwt, but it
      // also lists `none`, which is what our metadata offers, so ChatGPT
      // authenticates as a public PKCE client here.
      fetcher: documentFetcher(
        {
          client_id: CHATGPT_CLIENT,
          client_uri: 'https://chatgpt.com/',
          redirect_uris: [CHATGPT_REDIRECT],
          token_endpoint_auth_method: 'private_key_jwt',
          token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: 'ChatGPT',
          logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
          token_endpoint_auth_signing_alg: 'RS256',
          jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
        },
        calls,
      ),
    });
    const connection = await createConnection(h, 'sales@example.test');
    const { verifier, challenge } = pkcePair();
    const result = await authorize(h, {
      clientId: CHATGPT_CLIENT,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
      redirectUri: CHATGPT_REDIRECT,
    });
    expect(result.loginResponse.body).toContain('ChatGPT');
    expect(result.loginResponse.body).toContain('chatgpt.com');
    const location = new URL(result.location ?? '');
    expect(location.searchParams.get('iss')).toBe('https://mcp.example.test');
    const token = await exchangeCode(h, {
      clientId: CHATGPT_CLIENT,
      code: location.searchParams.get('code') ?? '',
      verifier,
      connectionId: connection.id,
      redirectUri: CHATGPT_REDIRECT,
    });
    expect(token.statusCode).toBe(200);
    expect(calls).toEqual([CHATGPT_CLIENT]); // fetched once, then served from cache
  });

  it.each([
    [
      'a client_id that does not match the document URL',
      {
        client_id: 'https://other.example/client.json',
        client_name: 'x',
        redirect_uris: [CHATGPT_REDIRECT],
      },
    ],
    [
      'a non-https redirect URI',
      { client_id: CHATGPT_CLIENT, client_name: 'x', redirect_uris: ['http://evil.example/cb'] },
    ],
    [
      'a client that cannot use auth method none',
      {
        client_id: CHATGPT_CLIENT,
        client_name: 'x',
        redirect_uris: [CHATGPT_REDIRECT],
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
      },
    ],
    [
      'a document missing client_name',
      { client_id: CHATGPT_CLIENT, redirect_uris: [CHATGPT_REDIRECT] },
    ],
  ])('rejects %s', async (_label, document) => {
    h = await createHarness({ fetcher: documentFetcher(document) });
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CHATGPT_CLIENT,
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const response = await h.publicApp.inject({
      method: 'GET',
      url: `/oauth/authorize?${params.toString()}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it('enforces the postmaster’s trusted-host policy', async () => {
    const calls: string[] = [];
    h = await createHarness({ fetcher: documentFetcher({}, calls) });
    h.services.settings.update(
      {
        clientRegistration: {
          dynamicRegistration: true,
          metadataDocuments: true,
          allowedMetadataHosts: ['other-client.example'],
        },
      },
      h.clock.now().toISOString(),
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CHATGPT_CLIENT,
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
    });
    const response = await h.publicApp.inject({
      method: 'GET',
      url: `/oauth/authorize?${params.toString()}`,
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]); // refused before any fetch
  });
});

describe('Dynamic Client Registration', () => {
  it('registers a confidential client by default (RFC 7591) and authenticates it with the secret only', async () => {
    h = await createHarness();
    const response = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        redirect_uris: ['https://client.example.test/callback'],
        client_name: 'Confidential',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      client_id: string;
      client_secret: string;
      token_endpoint_auth_method: string;
    };
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(body.client_secret).toMatch(/^mcp_cs_/);
    const stored = h.services.oauth.findClient(body.client_id);
    expect(JSON.stringify(stored)).not.toContain(body.client_secret);

    const wrong = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${body.client_id}:wrong`).toString('base64')}`,
      },
      payload: 'grant_type=refresh_token&refresh_token=x',
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('refuses non-https redirect URIs and unsupported grant types', async () => {
    h = await createHarness();
    const badRedirect = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'none' },
    });
    expect(badRedirect.statusCode).toBe(400);
    expect(badRedirect.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    const badGrant = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        redirect_uris: ['https://a.example/cb'],
        grant_types: ['password'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(badGrant.json()).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('can be disabled by the postmaster', async () => {
    h = await createHarness();
    h.services.settings.update(
      {
        clientRegistration: {
          dynamicRegistration: false,
          metadataDocuments: true,
          allowedMetadataHosts: [],
        },
      },
      h.clock.now().toISOString(),
    );
    const response = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'none' },
    });
    expect(response.statusCode).toBe(403);
    const metadata = await h.publicApp.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect((metadata.json() as Record<string, unknown>)['registration_endpoint']).toBeUndefined();
  });

  it('rejects token requests with duplicated parameters', async () => {
    h = await createHarness();
    const response = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=authorization_code&grant_type=refresh_token',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });
});
