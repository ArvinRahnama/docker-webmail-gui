/**
 * Shared test harness for apps/mcp (not collected as a suite — the file name
 * does not end in `.test.ts`, and the runtime image strips `*-test-harness.*`).
 *
 * Builds the real services, real migrations, real public + control Fastify
 * apps over an in-memory database and the fake mail backend, and provides
 * helpers that drive the real OAuth flow over HTTP exactly as a browser and
 * an MCP client would.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { MCP_CONTROL_AUTH_HEADER, type McpMailSettings, type McpScope } from '@dwg/shared';
import { loadMcpConfig, type McpConfig } from './config.js';
import { createDatabase } from './platform/db.js';
import { migrations, runMigrations } from './platform/migrations/index.js';
import { createMcpLogger } from './platform/logger.js';
import { buildServices, type Services } from './services.js';
import { buildPublicApp } from './public/public-app.js';
import { buildControlApp } from './control/control-app.js';
import { FakeMailBackend } from './mail/fake-backend.js';
import type { MailBackend } from './mail/types.js';
import type { MetadataFetcher } from './oauth/safe-fetch.js';
import type { Clock } from './platform/clock.js';
import { transactionCookieName } from './public/oauth.routes.js';

export const PUBLIC_BASE = 'https://mcp.example.test';
export const REDIRECT_URI = 'https://client.example.test/callback';

export class MutableClock implements Clock {
  constructor(
    private current: Date = new Date('2026-10-15T12:00:00.000Z'),
    private readonly realTime = false,
  ) {}
  now(): Date {
    return this.realTime ? new Date() : new Date(this.current.getTime());
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export interface Harness {
  readonly config: McpConfig;
  readonly services: Services;
  readonly publicApp: FastifyInstance;
  readonly controlApp: FastifyInstance;
  readonly mail: FakeMailBackend;
  readonly clock: MutableClock;
  readonly logLines: string[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly enabled?: boolean;
  /** Use this backend instead of the fake (integration tests: the real IMAP/SMTP backend). */
  readonly backend?: MailBackend;
  readonly mailSettings?: McpMailSettings;
  readonly fetcher?: MetadataFetcher;
  readonly passwords?: ReadonlyMap<string, string>;
  readonly vaultKey?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const logLines: string[] = [];
  const logger = createMcpLogger({
    level: 'trace',
    stream: { write: (chunk: string) => void logLines.push(chunk) },
  });
  const config = loadMcpConfig({
    APP_MODE: 'development',
    ...(options.vaultKey === false ? {} : { MCP_VAULT_KEY: randomBytes(32).toString('hex') }),
    MCP_PUBLIC_URL: PUBLIC_BASE,
    MCP_MAIL_BACKEND: 'fake',
    MCP_REQUIRE_HTTPS: 'false',
    LOG_LEVEL: 'trace',
  });
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const mail = new FakeMailBackend({
    seed: true,
    passwords:
      options.passwords ??
      new Map([
        ['sales@example.test', 'sales-imap-password'],
        ['support@example.test', 'support-imap-password'],
      ]),
  });
  // Integration tests talk to a real mail server, whose own clock matters for search/date logic.
  const clock = new MutableClock(undefined, options.backend !== undefined);
  const services = buildServices({
    config,
    db,
    logger,
    mail: options.backend ?? mail,
    clock,
    fetcher:
      options.fetcher ??
      (async () => {
        throw new Error('no network in tests');
      }),
  });
  if (options.enabled !== false) {
    services.settings.update({ enabled: true }, clock.now().toISOString());
  }
  if (options.mailSettings !== undefined) {
    services.settings.update({ mail: options.mailSettings }, clock.now().toISOString());
  }
  const publicApp = await buildPublicApp(services, logger);
  const controlApp = await buildControlApp(services, logger);
  return {
    config,
    services,
    publicApp,
    controlApp,
    mail,
    clock,
    logLines,
    async close() {
      await publicApp.close();
      await controlApp.close();
      db.close();
    },
  };
}

export function control(
  h: Harness,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return h.controlApp.inject({
    method,
    url: `/control/v1${url}`,
    headers: { [MCP_CONTROL_AUTH_HEADER]: h.services.config.controlSecret },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Fingerprint stand-in: what apps/server would compute from the DMS hash line. */
export function fingerprint(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

export interface CreatedConnection {
  readonly id: string;
  readonly username: string;
  readonly setupPassword: string;
  readonly mcpUrl: string;
}

export async function createConnection(
  h: Harness,
  mailbox: string,
  options: { permissions?: McpScope[]; password?: string; fingerprintSeed?: string } = {},
): Promise<CreatedConnection> {
  const response = await control(h, 'POST', '/connections', {
    mailbox,
    mailboxFingerprint: fingerprint(options.fingerprintSeed ?? `${mailbox}-v1`),
    label: `Test ${mailbox}`,
    permissions: options.permissions ?? ['mail.read', 'mail.send', 'mail.delete'],
    mailboxPassword:
      options.password ??
      (mailbox.startsWith('sales') ? 'sales-imap-password' : 'support-imap-password'),
    actor: 'postmaster@example.test',
  });
  if (response.statusCode !== 201)
    throw new Error(`create failed: ${response.statusCode} ${response.body}`);
  const body = response.json() as {
    connection: { id: string; mcpUrl: string };
    oneTimeCredential: { username: string; setupPassword: string };
  };
  return {
    id: body.connection.id,
    mcpUrl: body.connection.mcpUrl,
    username: body.oneTimeCredential.username,
    setupPassword: body.oneTimeCredential.setupPassword,
  };
}

export async function registerClient(h: Harness, redirectUri = REDIRECT_URI): Promise<string> {
  const response = await h.publicApp.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: {
      redirect_uris: [redirectUri],
      client_name: 'Test MCP Client',
      token_endpoint_auth_method: 'none',
    },
  });
  if (response.statusCode !== 201)
    throw new Error(`register failed: ${response.statusCode} ${response.body}`);
  return (response.json() as { client_id: string }).client_id;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no hidden field ${name} in page`);
  return match[1];
}

export interface AuthorizeResult {
  readonly location: string | null;
  readonly loginResponse: LightMyRequestResponse;
  readonly consentResponse: LightMyRequestResponse | null;
}

/** Drives GET /oauth/authorize → login → decision exactly as a browser would. */
export async function authorize(
  h: Harness,
  input: {
    clientId: string;
    connectionId: string | null;
    username: string;
    password: string;
    challenge: string;
    scope?: string;
    decision?: 'approve' | 'deny';
    redirectUri?: string;
    state?: string;
  },
): Promise<AuthorizeResult> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? REDIRECT_URI,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state ?? 'state-123',
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.connectionId !== null
      ? { resource: `${PUBLIC_BASE}/mcp/${input.connectionId}` }
      : {}),
  });
  const start = await h.publicApp.inject({
    method: 'GET',
    url: `/oauth/authorize?${params.toString()}`,
  });
  if (start.statusCode !== 200)
    throw new Error(`authorize start failed: ${start.statusCode} ${start.body.slice(0, 300)}`);
  const cookieName = transactionCookieName(true);
  const cookie = start.cookies.find((c) => c.name === cookieName);
  if (cookie === undefined) throw new Error('no transaction cookie');
  const txn = hidden(start.body, 'txn');
  const csrf = hidden(start.body, 'csrf');
  const loginResponse = await h.publicApp.inject({
    method: 'POST',
    url: '/oauth/authorize/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    cookies: { [cookieName]: cookie.value },
    payload: new URLSearchParams({
      txn,
      csrf,
      username: input.username,
      password: input.password,
    }).toString(),
  });
  if (!loginResponse.body.includes('name="decision"')) {
    return { location: null, loginResponse, consentResponse: null };
  }
  const consentResponse = await h.publicApp.inject({
    method: 'POST',
    url: '/oauth/authorize/decision',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    cookies: { [cookieName]: cookie.value },
    payload: new URLSearchParams({ txn, csrf, decision: input.decision ?? 'approve' }).toString(),
  });
  return {
    location: consentResponse.headers.location?.toString() ?? null,
    loginResponse,
    consentResponse,
  };
}

export async function exchangeCode(
  h: Harness,
  input: {
    clientId: string;
    code: string;
    verifier: string;
    connectionId: string;
    redirectUri?: string;
  },
): Promise<LightMyRequestResponse> {
  return h.publicApp.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri ?? REDIRECT_URI,
      resource: `${PUBLIC_BASE}/mcp/${input.connectionId}`,
    }).toString(),
  });
}

export async function refreshTokens(
  h: Harness,
  clientId: string,
  refreshToken: string,
): Promise<LightMyRequestResponse> {
  return h.publicApp.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
  });
}

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly clientId: string;
}

/** Full happy path: register client → authorize → exchange. */
export async function connectClient(
  h: Harness,
  connection: CreatedConnection,
  scope?: string,
): Promise<Tokens> {
  const clientId = await registerClient(h);
  const { verifier, challenge } = pkcePair();
  const result = await authorize(h, {
    clientId,
    connectionId: connection.id,
    username: connection.username,
    password: connection.setupPassword,
    challenge,
    ...(scope !== undefined ? { scope } : {}),
  });
  if (result.location === null)
    throw new Error(`authorization did not redirect: ${result.loginResponse.body.slice(0, 500)}`);
  const code = new URL(result.location).searchParams.get('code');
  if (code === null) throw new Error(`no code in ${result.location}`);
  const token = await exchangeCode(h, { clientId, code, verifier, connectionId: connection.id });
  if (token.statusCode !== 200)
    throw new Error(`token exchange failed: ${token.statusCode} ${token.body}`);
  const body = token.json() as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token, clientId };
}

let rpcId = 0;
/** Sends one JSON-RPC request to /mcp/<id> the 2025-era way (stateless), parsing JSON or SSE. */
export async function mcpCall(
  h: Harness,
  connectionId: string,
  accessToken: string | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: unknown }> {
  rpcId += 1;
  const response = await h.publicApp.inject({
    method: 'POST',
    url: `/mcp/${connectionId}`,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...(accessToken !== null ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    payload: { jsonrpc: '2.0', id: rpcId, method, params },
  });
  let body: unknown = null;
  const text = response.body;
  if (text.length > 0) {
    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType.includes('text/event-stream')) {
      const data = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0);
      body = data.length > 0 ? JSON.parse(data[data.length - 1]!) : null;
    } else {
      body = JSON.parse(text);
    }
  }
  return {
    status: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    body,
  };
}

/** Calls a tool and returns the CallToolResult. */
export async function callTool(
  h: Harness,
  connectionId: string,
  accessToken: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}> {
  const response = await mcpCall(h, connectionId, accessToken, 'tools/call', {
    name,
    arguments: args,
  });
  const body = response.body as { result?: unknown; error?: { message: string } };
  if (body?.result === undefined)
    throw new Error(`tools/call ${name} failed: ${response.status} ${JSON.stringify(body)}`);
  return body.result as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
}
