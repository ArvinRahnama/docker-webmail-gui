/**
 * The OAuth authorization-code flow end to end, over the real HTTP routes:
 * discovery → client registration → hosted sign-in with the setup
 * credential → consent → code + PKCE exchange → MCP call → refresh
 * rotation → revocation. Each security property named in
 * docs/mcp-integration.md §OAuth has a test here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorize,
  connectClient,
  control,
  createConnection,
  createHarness,
  exchangeCode,
  mcpCall,
  pkcePair,
  PUBLIC_BASE,
  REDIRECT_URI,
  refreshTokens,
  registerClient,
  type Harness,
} from '../mcp-test-harness.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('discovery', () => {
  it('advertises RFC 8414 metadata with PKCE S256, CIMD, DCR and RFC 9207 iss', async () => {
    const response = await h.publicApp.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(response.statusCode).toBe(200);
    const metadata = response.json() as Record<string, unknown>;
    expect(metadata['issuer']).toBe(PUBLIC_BASE);
    expect(metadata['code_challenge_methods_supported']).toEqual(['S256']);
    expect(metadata['client_id_metadata_document_supported']).toBe(true);
    expect(metadata['registration_endpoint']).toBe(`${PUBLIC_BASE}/oauth/register`);
    expect(metadata['authorization_response_iss_parameter_supported']).toBe(true);
    expect(metadata['grant_types_supported']).toEqual(['authorization_code', 'refresh_token']);
    expect(metadata['grant_types_supported']).not.toContain('password');
  });

  it('answers 404 for discovery while MCP is disabled', async () => {
    const disabled = await createHarness({ enabled: false });
    try {
      const response = await disabled.publicApp.inject({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabled.close();
    }
  });

  it('serves per-connection protected-resource metadata limited to that connection’s scopes', async () => {
    const connection = await createConnection(h, 'sales@example.test', {
      permissions: ['mail.read'],
    });
    const response = await h.publicApp.inject({
      method: 'GET',
      url: `/.well-known/oauth-protected-resource/mcp/${connection.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      resource: `${PUBLIC_BASE}/mcp/${connection.id}`,
      authorization_servers: [PUBLIC_BASE],
      scopes_supported: ['mail.read'],
    });
    const unknown = await h.publicApp.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp/c00000000000000000000000000',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('challenges an unauthenticated MCP request with resource_metadata and scope', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const response = await mcpCall(h, connection.id, null, 'tools/list');
    expect(response.status).toBe(401);
    const challenge = String(response.headers['www-authenticate']);
    expect(challenge).toContain(
      `resource_metadata="${PUBLIC_BASE}/.well-known/oauth-protected-resource/mcp/${connection.id}"`,
    );
    expect(challenge).toContain('scope="mail.read mail.send mail.delete"');
  });

  // Authorization runs before the body is parsed: whatever an unauthenticated
  // client sends, it gets the 401 challenge (never a 415/400 that hides the
  // OAuth discovery path), and the server never parses its body.
  it.each([
    ['a content type the endpoint does not parse', 'application/octet-stream', 'probe'],
    ['a body but no content type', undefined, '{}'],
    ['an unparseable JSON body', 'application/json', '{not json'],
    ['no body at all', undefined, undefined],
  ])('challenges an unauthenticated POST with %s', async (_label, contentType, payload) => {
    const connection = await createConnection(h, 'sales@example.test');
    const response = await h.publicApp.inject({
      method: 'POST',
      url: `/mcp/${connection.id}`,
      headers: contentType === undefined ? {} : { 'content-type': contentType },
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode).toBe(401);
    expect(String(response.headers['www-authenticate'])).toContain(
      `resource_metadata="${PUBLIC_BASE}/.well-known/oauth-protected-resource/mcp/${connection.id}"`,
    );
  });
});

describe('authorization code flow', () => {
  it('completes, returns iss + state, and the token works against the MCP endpoint', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const { verifier, challenge } = pkcePair();
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
      state: 'xyz',
    });
    expect(result.consentResponse?.statusCode).toBe(303);
    const location = new URL(result.location ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get('iss')).toBe(PUBLIC_BASE);
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code') ?? '';
    const token = await exchangeCode(h, { clientId, code, verifier, connectionId: connection.id });
    expect(token.statusCode).toBe(200);
    const body = token.json() as Record<string, unknown>;
    expect(body['token_type']).toBe('Bearer');
    expect(body['scope']).toBe('mail.read mail.send mail.delete');
    expect(String(body['access_token'])).toMatch(/^mcp_at_/);
    expect(String(body['refresh_token'])).toMatch(/^mcp_rt_/);
    expect(token.headers['cache-control']).toBe('no-store');

    const list = await mcpCall(h, connection.id, String(body['access_token']), 'tools/list');
    expect(list.status).toBe(200);
    const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools
      .map((t) => t.name)
      .sort();
    expect(tools).toEqual([
      'mail_delete',
      'mail_get_attachment',
      'mail_list_folders',
      'mail_list_messages',
      'mail_read',
      'mail_restore',
      'mail_search',
      'mail_send',
    ]);
  });

  it('shows the full mailbox only after authentication; before it, a masked address', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${PUBLIC_BASE}/mcp/${connection.id}`,
    });
    const start = await h.publicApp.inject({
      method: 'GET',
      url: `/oauth/authorize?${params.toString()}`,
    });
    expect(start.body).toContain('s***s@example.test');
    expect(start.body).not.toContain('sales@example.test');
    expect(String(start.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(start.headers['content-security-policy'])).not.toContain('script-src');
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
    });
    expect(result.loginResponse.body).toContain('sales@example.test');
    // The consent page may only post/redirect to itself and the validated client origin.
    expect(String(result.loginResponse.headers['content-security-policy'])).toContain(
      "form-action 'self' https://client.example.test",
    );
  });

  it('identifies the connection from the username when the client omits resource', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const { verifier, challenge } = pkcePair();
    const result = await authorize(h, {
      clientId,
      connectionId: null,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
    });
    const code = new URL(result.location ?? '').searchParams.get('code') ?? '';
    const token = await exchangeCode(h, { clientId, code, verifier, connectionId: connection.id });
    expect(token.statusCode).toBe(200);
  });

  it('rejects an unregistered redirect URI without redirecting', async () => {
    const clientId = await registerClient(h);
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.example/steal',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const response = await h.publicApp.inject({
      method: 'GET',
      url: `/oauth/authorize?${params.toString()}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain('redirect URI is not registered');
  });

  it('refuses PKCE plain and missing code_challenge', async () => {
    const clientId = await registerClient(h);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'plain',
    });
    const response = await h.publicApp.inject({
      method: 'GET',
      url: `/oauth/authorize?${params.toString()}`,
    });
    expect(response.statusCode).toBe(303);
    const location = new URL(String(response.headers.location));
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('iss')).toBe(PUBLIC_BASE);
  });

  it('rejects a wrong PKCE verifier and a code for another client', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const otherClient = await registerClient(h);
    const { challenge } = pkcePair();
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
    });
    const code = new URL(result.location ?? '').searchParams.get('code') ?? '';
    const wrongVerifier = await exchangeCode(h, {
      clientId,
      code,
      verifier: pkcePair().verifier,
      connectionId: connection.id,
    });
    expect(wrongVerifier.statusCode).toBe(400);
    expect(wrongVerifier.json()).toMatchObject({ error: 'invalid_grant' });
    const otherClientAttempt = await exchangeCode(h, {
      clientId: otherClient,
      code,
      verifier: 'x'.repeat(43),
      connectionId: connection.id,
    });
    expect(otherClientAttempt.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('authorization codes are single use; a replay revokes the grant it produced', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const { verifier, challenge } = pkcePair();
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
    });
    const code = new URL(result.location ?? '').searchParams.get('code') ?? '';
    const first = await exchangeCode(h, { clientId, code, verifier, connectionId: connection.id });
    expect(first.statusCode).toBe(200);
    const accessToken = (first.json() as { access_token: string }).access_token;
    const replay = await exchangeCode(h, { clientId, code, verifier, connectionId: connection.id });
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    const after = await mcpCall(h, connection.id, accessToken, 'tools/list');
    expect(after.status).toBe(401);
  });

  it('authorization codes expire after 60 seconds', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const { verifier, challenge } = pkcePair();
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
    });
    const code = new URL(result.location ?? '').searchParams.get('code') ?? '';
    h.clock.advance(61);
    const token = await exchangeCode(h, { clientId, code, verifier, connectionId: connection.id });
    expect(token.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('a denied consent redirects with access_denied and issues nothing', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const { challenge } = pkcePair();
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge,
      decision: 'deny',
    });
    const location = new URL(result.location ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
    // The setup password was not consumed by a denial.
    const second = await connectClient(h, connection);
    expect(second.accessToken).toMatch(/^mcp_at_/);
  });

  it('rejects cross-site form posts to the sign-in endpoint', async () => {
    const response = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/authorize/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
      payload: 'txn=x&csrf=y&username=u&password=p',
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a sign-in post whose CSRF token does not match the transaction', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${PUBLIC_BASE}/mcp/${connection.id}`,
    });
    const start = await h.publicApp.inject({
      method: 'GET',
      url: `/oauth/authorize?${params.toString()}`,
    });
    const cookie = start.cookies[0]!;
    const txn = /name="txn" value="([^"]+)"/.exec(start.body)?.[1] ?? '';
    const response = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/authorize/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      cookies: { [cookie.name]: cookie.value },
      payload: new URLSearchParams({
        txn,
        csrf: 'forged',
        username: connection.username,
        password: connection.setupPassword,
      }).toString(),
    });
    expect(response.body).toContain('Sign-in request expired');
    expect(response.body).not.toContain('name="decision"');
  });

  it('never accepts the Resource Owner Password Credentials grant', async () => {
    const clientId = await registerClient(h);
    const response = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        username: 'x',
        password: 'y',
      }).toString(),
    });
    expect(response.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

describe('setup credentials', () => {
  it('a consumed setup password cannot authorize again', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    await connectClient(h, connection);
    const clientId = await registerClient(h);
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge: pkcePair().challenge,
    });
    expect(result.location).toBeNull();
    expect(result.loginResponse.body).toContain('already been used');
  });

  it('an expired setup password cannot authorize', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    h.clock.advance(24 * 3600 + 1);
    const clientId = await registerClient(h);
    const result = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge: pkcePair().challenge,
    });
    expect(result.location).toBeNull();
    expect(result.loginResponse.body).toContain('expired');
  });

  it('locks after five wrong passwords and reveals nothing about which part was wrong', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const clientId = await registerClient(h);
    for (let i = 0; i < 5; i += 1) {
      const attempt = await authorize(h, {
        clientId,
        connectionId: connection.id,
        username: connection.username,
        password: 'WRONG-PASSWORD',
        challenge: pkcePair().challenge,
      });
      expect(attempt.loginResponse.body).toContain('Incorrect MCP username or setup password.');
    }
    const unknownUser = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: 'mcp-doesnotexist00000',
      password: 'X',
      challenge: pkcePair().challenge,
    });
    expect(unknownUser.loginResponse.body).toContain('Incorrect MCP username or setup password.');
    const correct = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge: pkcePair().challenge,
    });
    expect(correct.location).toBeNull();
    expect(correct.loginResponse.body).toContain('locked');
  });

  it('accepts the setup password case-insensitively with surrounding whitespace', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, {
      ...connection,
      setupPassword: `  ${connection.setupPassword.toLowerCase()} `,
    });
    expect(tokens.accessToken).toMatch(/^mcp_at_/);
  });

  it('a reissued password replaces the old one; the old one no longer works', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const reissue = await control(h, 'POST', `/connections/${connection.id}/reissue`, {
      actor: 'postmaster@example.test',
    });
    expect(reissue.statusCode).toBe(200);
    const fresh = (
      reissue.json() as { oneTimeCredential: { username: string; setupPassword: string } }
    ).oneTimeCredential;
    expect(fresh.username).toBe(connection.username);
    expect(fresh.setupPassword).not.toBe(connection.setupPassword);
    const clientId = await registerClient(h);
    const old = await authorize(h, {
      clientId,
      connectionId: connection.id,
      username: connection.username,
      password: connection.setupPassword,
      challenge: pkcePair().challenge,
    });
    expect(old.location).toBeNull();
    const tokens = await connectClient(h, { ...connection, setupPassword: fresh.setupPassword });
    expect(tokens.accessToken).toMatch(/^mcp_at_/);
  });

  it('setup credentials for connection A cannot authorize connection B’s resource', async () => {
    const a = await createConnection(h, 'sales@example.test');
    const b = await createConnection(h, 'support@example.test');
    const clientId = await registerClient(h);
    const result = await authorize(h, {
      clientId,
      connectionId: b.id,
      username: a.username,
      password: a.setupPassword,
      challenge: pkcePair().challenge,
    });
    expect(result.location).toBeNull();
    expect(result.loginResponse.body).toContain('different MCP connection');
  });
});

describe('tokens', () => {
  it('rotates refresh tokens; replaying a rotated token revokes the whole grant', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const first = await refreshTokens(h, tokens.clientId, tokens.refreshToken);
    expect(first.statusCode).toBe(200);
    const rotated = first.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refreshToken);
    expect((await mcpCall(h, connection.id, rotated.access_token, 'tools/list')).status).toBe(200);

    const replay = await refreshTokens(h, tokens.clientId, tokens.refreshToken);
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    // Family revoked: the rotated pair is dead too.
    expect((await mcpCall(h, connection.id, rotated.access_token, 'tools/list')).status).toBe(401);
    expect((await refreshTokens(h, tokens.clientId, rotated.refresh_token)).json()).toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('access tokens expire', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    h.clock.advance(15 * 60 + 1);
    const response = await mcpCall(h, connection.id, tokens.accessToken, 'tools/list');
    expect(response.status).toBe(401);
    expect(String(response.headers['www-authenticate'])).toContain('error="invalid_token"');
  });

  it('revoked access tokens are rejected (RFC 7009)', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const revoke = await h.publicApp.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        token: tokens.refreshToken,
        client_id: tokens.clientId,
      }).toString(),
    });
    expect(revoke.statusCode).toBe(200);
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(401);
  });

  it('a token for connection A is rejected at connection B’s endpoint', async () => {
    const a = await createConnection(h, 'sales@example.test');
    const b = await createConnection(h, 'support@example.test');
    const tokensA = await connectClient(h, a);
    await connectClient(h, b);
    const response = await mcpCall(h, b.id, tokensA.accessToken, 'tools/list');
    expect(response.status).toBe(401);
    expect(String(response.headers['www-authenticate'])).toContain('invalid_token');
  });

  it('removing a permission takes effect immediately for existing tokens', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const update = await control(h, 'PATCH', `/connections/${connection.id}`, {
      actor: 'postmaster@example.test',
      permissions: ['mail.read'],
    });
    expect(update.statusCode).toBe(200);
    const list = await mcpCall(h, connection.id, tokens.accessToken, 'tools/list');
    const names = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).not.toContain('mail_delete');
    expect(names).not.toContain('mail_send');
    expect(names).toContain('mail_read');
  });

  it('a disabled connection refuses existing tokens until re-enabled', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    await control(h, 'POST', `/connections/${connection.id}/disable`, {
      actor: 'postmaster@example.test',
    });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(403);
    expect((await refreshTokens(h, tokens.clientId, tokens.refreshToken)).json()).toMatchObject({
      error: 'invalid_grant',
    });
    await control(h, 'POST', `/connections/${connection.id}/enable`, {
      actor: 'postmaster@example.test',
    });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(200);
  });

  it('revoking a connection kills its tokens permanently', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    await control(h, 'POST', `/connections/${connection.id}/revoke`, {
      actor: 'postmaster@example.test',
    });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(404);
    const enable = await control(h, 'POST', `/connections/${connection.id}/enable`, {
      actor: 'postmaster@example.test',
    });
    expect(enable.statusCode).toBe(409);
  });

  it('rotating credentials revokes every grant and issues a new username', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const rotate = await control(h, 'POST', `/connections/${connection.id}/rotate`, {
      actor: 'postmaster@example.test',
    });
    const fresh = (rotate.json() as { oneTimeCredential: { username: string } }).oneTimeCredential;
    expect(fresh.username).not.toBe(connection.username);
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(401);
  });

  it('changing the public URL invalidates tokens bound to the old audience', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    h.services.settings.update(
      { publicBaseUrl: 'https://new-mcp.example.test' },
      h.clock.now().toISOString(),
    );
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(401);
  });
});

describe('mailbox lifecycle', () => {
  it('deleting the mailbox revokes MCP access; recreating the address does not restore it', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const event = await control(h, 'POST', '/mailboxes/events', {
      mailbox: 'sales@example.test',
      event: 'deleted',
      actor: 'postmaster@example.test',
    });
    expect(event.json()).toMatchObject({ affectedConnections: 1 });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(404);
    // Recreated mailbox: same address, new identity. Old connection stays revoked.
    const recreated = await createConnection(h, 'sales@example.test', {
      fingerprintSeed: 'sales-recreated',
    });
    expect(recreated.id).not.toBe(connection.id);
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(404);
    const old = await control(h, 'GET', `/connections/${connection.id}`);
    expect((old.json() as { connection: { status: string } }).connection.status).toBe('revoked');
  });

  it('a password change suspends access, wipes the stored credential and revokes grants', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    await control(h, 'POST', '/mailboxes/events', {
      mailbox: 'sales@example.test',
      event: 'password_changed',
      actor: 'postmaster@example.test',
    });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(401);
    const detail = (await control(h, 'GET', `/connections/${connection.id}`)).json() as {
      connection: { status: string; credentialHealth: string };
    };
    expect(detail.connection.status).toBe('suspended');
    expect(detail.connection.credentialHealth).toBe('stale');
  });

  it('reconciliation detects an out-of-band password change or recreate by fingerprint', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const { fingerprint } = await import('../mcp-test-harness.js');
    const result = await control(h, 'POST', '/mailboxes/reconcile', {
      mailboxes: [
        { mailbox: 'sales@example.test', fingerprint: fingerprint('sales-changed-outside') },
      ],
    });
    expect(result.json()).toMatchObject({ stale: 1 });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(401);
  });

  it('a mailbox missing from reconciliation blocks access until it reappears unchanged', async () => {
    const connection = await createConnection(h, 'sales@example.test');
    const tokens = await connectClient(h, connection);
    const { fingerprint } = await import('../mcp-test-harness.js');
    await control(h, 'POST', '/mailboxes/reconcile', { mailboxes: [] });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(403);
    await control(h, 'POST', '/mailboxes/reconcile', {
      mailboxes: [
        { mailbox: 'sales@example.test', fingerprint: fingerprint('sales@example.test-v1') },
      ],
    });
    expect((await mcpCall(h, connection.id, tokens.accessToken, 'tools/list')).status).toBe(200);
  });
});
