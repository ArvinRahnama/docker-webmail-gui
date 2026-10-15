/**
 * The browser-facing half of the authorization-code flow:
 *
 *   GET  /oauth/authorize           → validate the request, render sign-in
 *   POST /oauth/authorize/login     → verify the setup credential, render consent
 *   POST /oauth/authorize/decision  → approve (mint code) or deny, redirect back
 *
 * Invariants:
 *  - Until the client and its exact redirect URI are validated, errors are
 *    shown on an error page and **never** redirected (no open redirect).
 *  - The connection — and therefore the mailbox — is determined server-side:
 *    from the validated `resource` indicator if present, and always from the
 *    enrollment the user authenticates with; the two must agree. Nothing in
 *    client metadata or user input can create or select another connection.
 *  - The setup password is verified with Argon2id (a dummy hash for unknown
 *    usernames), counted towards a per-enrollment lockout and a per-IP
 *    throttle, and is consumed only when the resulting code is redeemed.
 *  - Every POST must carry the transaction cookie, the matching hidden
 *    transaction id, and the per-transaction CSRF token, from a same-origin
 *    page.
 */
import { randomBytes } from 'node:crypto';
import { MCP_SCOPES, type McpScope } from '@dwg/shared';
import type { Clock } from '../platform/clock.js';
import { addSeconds } from '../platform/clock.js';
import { OAuthError } from '../platform/errors.js';
import type { Database } from '../platform/db.js';
import {
  generateOpaqueToken,
  generateRowId,
  normalizeSetupPassword,
  sha256Hex,
  timingSafeEqualString,
} from '../crypto/random.js';
import { DUMMY_SECRET_HASH, verifySecret } from '../crypto/password-hash.js';
import type { ConnectionsRepository, EnrollmentRow } from '../store/connections.repository.js';
import { ENROLLMENT_MAX_FAILED_ATTEMPTS } from '../store/connections.repository.js';
import type {
  AuthorizationRequestRow,
  OAuthClientRow,
  OAuthRepository,
} from '../store/oauth.repository.js';
import type { SettingsRepository } from '../store/settings.repository.js';
import type { BindingsRepository } from '../store/bindings.repository.js';
import type { McpAuditLog } from '../domain/audit.js';
import type { ConnectionsService } from '../domain/connections.service.js';
import type { ClientsService } from './clients.service.js';
import type { TokensService } from './tokens.service.js';
import { connectionIdFromResource, resourceFor } from './endpoints.js';
import { parseScopeParam } from './tokens.service.js';
import { maskMailbox, type ClientDisplay } from '../web/authorize-views.js';

export const AUTHORIZATION_REQUEST_TTL_SECONDS = 600;
const IP_FAILURE_WINDOW_SECONDS = 900;
const IP_FAILURE_LIMIT = 20;

export type AuthorizeOutcome =
  | {
      readonly kind: 'error_page';
      readonly title: string;
      readonly message: string;
      readonly status: number;
    }
  | { readonly kind: 'redirect'; readonly url: string }
  | {
      readonly kind: 'login';
      readonly txn: string;
      readonly csrf: string;
      readonly setCookie: boolean;
      readonly client: ClientDisplay;
      readonly maskedMailbox: string | null;
      readonly scopes: readonly McpScope[] | null;
      readonly expiresAt: string;
      readonly error: string | null;
      readonly username: string;
    }
  | {
      readonly kind: 'consent';
      readonly txn: string;
      readonly csrf: string;
      readonly client: ClientDisplay;
      readonly mailbox: string;
      readonly scopes: readonly McpScope[];
      readonly redirectOrigin: string;
    };

export interface AuthorizationServiceDeps {
  readonly db: Database;
  readonly settings: SettingsRepository;
  readonly clients: ClientsService;
  readonly tokens: TokensService;
  readonly oauth: OAuthRepository;
  readonly connectionsRepo: ConnectionsRepository;
  readonly bindings: BindingsRepository;
  readonly connections: ConnectionsService;
  readonly audit: McpAuditLog;
  readonly clock: Clock;
  readonly requireHttps: boolean;
}

function errorPage(title: string, message: string, status = 400): AuthorizeOutcome {
  return { kind: 'error_page', title, message, status };
}

function single(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return null; // repeated or structured parameter
}

const QUERY_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const;

export class AuthorizationService {
  constructor(private readonly deps: AuthorizationServiceDeps) {}

  private issuer(): string | null {
    const settings = this.deps.settings.get();
    if (!settings.enabled || settings.publicBaseUrl === null) return null;
    if (this.deps.requireHttps && !settings.publicBaseUrl.startsWith('https://')) return null;
    return settings.publicBaseUrl;
  }

  private clientDisplay(client: OAuthClientRow, redirectUri: string): ClientDisplay {
    let redirectHost = 'unknown';
    let loopback = false;
    try {
      const url = new URL(redirectUri);
      redirectHost = url.host;
      loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
      // validated earlier; unreachable
    }
    let clientIdHost: string | null = null;
    if (client.kind === 'cimd') {
      try {
        clientIdHost = new URL(client.clientId).host;
      } catch {
        clientIdHost = null;
      }
    }
    return { name: client.clientName, clientIdHost, redirectHost, loopbackRedirect: loopback };
  }

  private redirectWith(
    redirectUri: string,
    issuer: string,
    params: Record<string, string | null>,
  ): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null) url.searchParams.set(key, value);
    }
    // RFC 9207: iss on every authorization response, success or error.
    url.searchParams.set('iss', issuer);
    return url.toString();
  }

  async start(query: Record<string, unknown>, ip: string | null): Promise<AuthorizeOutcome> {
    const issuer = this.issuer();
    if (issuer === null) {
      return errorPage(
        'MCP access is unavailable',
        'This server is not currently accepting MCP authorizations.',
        503,
      );
    }
    const params: Partial<Record<(typeof QUERY_PARAMS)[number], string>> = {};
    for (const name of QUERY_PARAMS) {
      const value = single(query[name]);
      if (value === null)
        return errorPage('Invalid request', `The "${name}" parameter must appear at most once.`);
      if (value !== undefined) params[name] = value;
    }
    if (params.client_id === undefined)
      return errorPage(
        'Invalid request',
        'The request does not identify an application (client_id).',
      );

    let client: OAuthClientRow;
    try {
      client = await this.deps.clients.resolve(params.client_id, ip);
    } catch (err) {
      return errorPage(
        'Unknown application',
        err instanceof OAuthError ? err.description : 'The application could not be identified.',
      );
    }
    const redirectUri = this.deps.clients.selectRedirectUri(client, params.redirect_uri);
    if (redirectUri === null) {
      return errorPage(
        'Invalid redirect',
        'The redirect URI is not registered for this application, so this request cannot continue.',
      );
    }
    // From here on errors go back to the client.
    const fail = (error: string, description: string): AuthorizeOutcome => ({
      kind: 'redirect',
      url: this.redirectWith(redirectUri, issuer, {
        error,
        error_description: description,
        state: params.state ?? null,
      }),
    });

    if (params.response_type !== 'code')
      return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (
      params.code_challenge === undefined ||
      !/^[A-Za-z0-9\-._~]{43,128}$/.test(params.code_challenge)
    ) {
      return fail('invalid_request', 'A PKCE code_challenge is required.');
    }
    if (params.code_challenge_method !== 'S256')
      return fail('invalid_request', 'code_challenge_method must be S256.');
    if (params.state !== undefined && params.state.length > 1000)
      return fail('invalid_request', 'state is too long.');

    let connectionId: string | null = null;
    if (params.resource !== undefined) {
      connectionId = connectionIdFromResource(issuer, params.resource);
      const connection =
        connectionId === null ? undefined : this.deps.connectionsRepo.findById(connectionId);
      if (connection === undefined || connection.state === 'revoked') {
        return fail('invalid_target', 'The requested resource is not available on this server.');
      }
    }
    const requested = parseScopeParam(params.scope);
    let displayScopes: McpScope[] | null = null;
    let maskedMailbox: string | null = null;
    if (connectionId !== null) {
      const connection = this.deps.connectionsRepo.findById(connectionId);
      if (connection !== undefined) {
        const base = requested.mail.length > 0 ? requested.mail : [...MCP_SCOPES];
        displayScopes = base.filter((scope) => connection.scopes.includes(scope));
        if (displayScopes.length === 0)
          return fail(
            'invalid_scope',
            'None of the requested permissions are allowed for this connection.',
          );
        maskedMailbox = maskMailbox(connection.mailbox);
      }
    }

    const now = this.deps.clock.now();
    const txn = generateOpaqueToken('mcp_tx');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = addSeconds(now, AUTHORIZATION_REQUEST_TTL_SECONDS).toISOString();
    this.deps.oauth.createAuthorizationRequest({
      id: txn,
      csrfTokenHash: sha256Hex(csrf),
      clientId: client.clientId,
      redirectUri,
      state: params.state ?? null,
      codeChallenge: params.code_challenge,
      requestedScopes: requested.mail.length > 0 ? requested.mail : null,
      resource: params.resource ?? null,
      connectionId,
      createdAt: now.toISOString(),
      expiresAt,
      ip,
    });
    return {
      kind: 'login',
      txn,
      csrf,
      setCookie: true,
      client: this.clientDisplay(client, redirectUri),
      maskedMailbox,
      scopes: displayScopes,
      expiresAt,
      error: null,
      username: '',
    };
  }

  /** Validates cookie ↔ form transaction binding and the CSRF token. */
  private loadTransaction(
    form: Record<string, string>,
    cookieTxn: string | undefined,
  ): AuthorizationRequestRow | AuthorizeOutcome {
    const txn = form['txn'];
    const csrf = form['csrf'];
    const expired = errorPage(
      'Sign-in request expired',
      'This authorization request is no longer valid. Start the connection again from your application.',
    );
    if (
      txn === undefined ||
      csrf === undefined ||
      cookieTxn === undefined ||
      !timingSafeEqualString(txn, cookieTxn)
    ) {
      return expired;
    }
    const request = this.deps.oauth.findAuthorizationRequest(txn);
    if (
      request === undefined ||
      request.completedAt !== null ||
      request.expiresAt <= this.deps.clock.now().toISOString()
    ) {
      return expired;
    }
    if (!timingSafeEqualString(sha256Hex(csrf), request.csrfTokenHash)) return expired;
    return request;
  }

  private ipThrottled(ip: string | null): boolean {
    if (ip === null) return false;
    const since = addSeconds(this.deps.clock.now(), -IP_FAILURE_WINDOW_SECONDS).toISOString();
    const row = this.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM mcp_login_attempts WHERE ip = ? AND success = 0 AND attempted_at >= ?',
      [ip, since],
    );
    return Number(row?.n ?? 0) >= IP_FAILURE_LIMIT;
  }

  private recordAttempt(ip: string | null, username: string, success: boolean): void {
    this.deps.db.run(
      'INSERT INTO mcp_login_attempts (id, ip, username, success, attempted_at) VALUES (?, ?, ?, ?, ?)',
      [
        generateRowId('la'),
        ip ?? 'unknown',
        username.slice(0, 64),
        success ? 1 : 0,
        this.deps.clock.now().toISOString(),
      ],
    );
  }

  /**
   * Usability checks shared by login and decision. Returns a user-facing
   * reason the setup credential / connection cannot be used, or null.
   */
  private enrollmentProblem(
    enrollment: EnrollmentRow,
    request: AuthorizationRequestRow,
  ): string | null {
    const now = this.deps.clock.now().toISOString();
    if (enrollment.revokedAt !== null)
      return 'These setup credentials were replaced or revoked. Ask your postmaster for new ones.';
    if (enrollment.lockedAt !== null)
      return 'Too many failed attempts locked these setup credentials. Ask your postmaster to reissue them.';
    if (enrollment.consumedAt !== null)
      return 'This setup password has already been used. If you need to connect again, ask your postmaster for new setup credentials.';
    if (enrollment.expiresAt <= now)
      return 'This setup password has expired. Ask your postmaster for new setup credentials.';
    if (
      enrollment.reservedUntil !== null &&
      enrollment.reservedUntil > now &&
      enrollment.reservedCodeId !== null
    ) {
      return 'This setup password is completing another authorization. Wait a minute and try again.';
    }
    if (request.connectionId !== null && request.connectionId !== enrollment.connectionId) {
      return 'These setup credentials belong to a different MCP connection than the one being connected. Check the MCP server URL you entered.';
    }
    const connection = this.deps.connectionsRepo.findById(enrollment.connectionId);
    if (connection === undefined) return 'This MCP connection no longer exists.';
    const binding = this.deps.bindings.findById(connection.bindingId);
    if (binding === undefined) return 'This MCP connection is not usable.';
    const { status } = this.deps.connections.statusOf(connection, binding);
    if (status !== 'pending' && status !== 'active') {
      return `This MCP connection is ${status}. Contact your postmaster.`;
    }
    return null;
  }

  private grantedScopes(
    request: AuthorizationRequestRow,
    connectionScopes: readonly McpScope[],
  ): McpScope[] {
    const base = request.requestedScopes ?? [...MCP_SCOPES];
    return base.filter((scope) => connectionScopes.includes(scope));
  }

  async login(
    form: Record<string, string>,
    cookieTxn: string | undefined,
    ip: string | null,
  ): Promise<AuthorizeOutcome> {
    if (this.issuer() === null) {
      return errorPage(
        'MCP access is unavailable',
        'This server is not currently accepting MCP authorizations.',
        503,
      );
    }
    const loaded = this.loadTransaction(form, cookieTxn);
    if ('kind' in loaded) return loaded;
    const request = loaded;
    const client = await this.deps.clients.resolve(request.clientId, ip).catch(() => null);
    if (client === null)
      return errorPage('Unknown application', 'The application could not be identified.');
    const display = this.clientDisplay(client, request.redirectUri);
    const connectionForDisplay =
      request.connectionId === null
        ? undefined
        : this.deps.connectionsRepo.findById(request.connectionId);
    const loginAgain = (error: string, username: string): AuthorizeOutcome => ({
      kind: 'login',
      txn: request.id,
      csrf: form['csrf'] ?? '',
      setCookie: false,
      client: display,
      maskedMailbox:
        connectionForDisplay === undefined ? null : maskMailbox(connectionForDisplay.mailbox),
      scopes:
        connectionForDisplay === undefined
          ? null
          : this.grantedScopes(request, connectionForDisplay.scopes),
      expiresAt: request.expiresAt,
      error,
      username,
    });

    const username = (form['username'] ?? '').trim().toLowerCase().slice(0, 64);
    const password = normalizeSetupPassword((form['password'] ?? '').slice(0, 128));
    if (this.ipThrottled(ip)) {
      return errorPage(
        'Too many attempts',
        'Too many failed sign-in attempts from your network. Try again in 15 minutes.',
        429,
      );
    }
    const enrollment =
      username.length > 0
        ? this.deps.connectionsRepo.findEnrollmentByUsername(username)
        : undefined;
    const passwordOk = await verifySecret(enrollment?.passwordHash ?? DUMMY_SECRET_HASH, password);
    if (enrollment === undefined || !passwordOk || password.length === 0) {
      this.recordAttempt(ip, username, false);
      let locked = false;
      if (
        enrollment !== undefined &&
        enrollment.lockedAt === null &&
        enrollment.consumedAt === null &&
        enrollment.revokedAt === null
      ) {
        const attempts = this.deps.connectionsRepo.recordFailedAttempt(
          enrollment.id,
          this.deps.clock.now().toISOString(),
        );
        locked = attempts >= ENROLLMENT_MAX_FAILED_ATTEMPTS;
      }
      this.deps.audit.record({
        event: locked ? 'enrollment.locked' : 'enrollment.login_failed',
        result: 'failure',
        actor: 'anonymous',
        connectionId: enrollment?.connectionId ?? null,
        ip,
        details: { knownUsername: enrollment !== undefined },
      });
      return loginAgain('Incorrect MCP username or setup password.', username);
    }
    const problem = this.enrollmentProblem(enrollment, request);
    if (problem !== null) {
      this.recordAttempt(ip, username, false);
      this.deps.audit.record({
        event: 'enrollment.login_failed',
        result: 'failure',
        actor: `enrollment:${enrollment.username}`,
        connectionId: enrollment.connectionId,
        ip,
        details: { reason: problem.slice(0, 80) },
      });
      return loginAgain(problem, username);
    }
    const connection = this.deps.connectionsRepo.findById(enrollment.connectionId);
    if (connection === undefined)
      return errorPage('Unavailable', 'This MCP connection no longer exists.');
    const scopes = this.grantedScopes(request, connection.scopes);
    if (scopes.length === 0)
      return loginAgain(
        'None of the requested permissions are allowed for this connection.',
        username,
      );

    this.recordAttempt(ip, username, true);
    this.deps.oauth.markRequestAuthenticated(
      request.id,
      connection.id,
      enrollment.id,
      this.deps.clock.now().toISOString(),
    );
    return {
      kind: 'consent',
      txn: request.id,
      csrf: form['csrf'] ?? '',
      client: display,
      mailbox: connection.mailbox,
      scopes,
      redirectOrigin: new URL(request.redirectUri).origin,
    };
  }

  async decide(
    form: Record<string, string>,
    cookieTxn: string | undefined,
    ip: string | null,
  ): Promise<AuthorizeOutcome> {
    const issuer = this.issuer();
    if (issuer === null) {
      return errorPage(
        'MCP access is unavailable',
        'This server is not currently accepting MCP authorizations.',
        503,
      );
    }
    const loaded = this.loadTransaction(form, cookieTxn);
    if ('kind' in loaded) return loaded;
    const request = loaded;
    if (
      request.authenticatedAt === null ||
      request.enrollmentId === null ||
      request.connectionId === null
    ) {
      return errorPage(
        'Sign in first',
        'Sign in with your MCP username and setup password before authorizing.',
      );
    }
    const client = await this.deps.clients.resolve(request.clientId, ip).catch(() => null);
    if (client === null)
      return errorPage('Unknown application', 'The application could not be identified.');
    const enrollment = this.deps.connectionsRepo.findEnrollmentById(request.enrollmentId);
    if (enrollment === undefined)
      return errorPage(
        'Sign-in request expired',
        'Start the connection again from your application.',
      );
    const decision = form['decision'];

    if (decision !== 'approve') {
      if (!this.deps.oauth.completeRequest(request.id, this.deps.clock.now().toISOString())) {
        return errorPage('Already completed', 'This authorization request was already completed.');
      }
      this.deps.audit.record({
        event: 'oauth.authorization_denied',
        result: 'success',
        actor: `enrollment:${enrollment.username}`,
        connectionId: request.connectionId,
        ip,
        details: { clientId: client.clientId },
      });
      return {
        kind: 'redirect',
        url: this.redirectWith(request.redirectUri, issuer, {
          error: 'access_denied',
          error_description: 'The user denied the authorization request.',
          state: request.state,
        }),
      };
    }

    const problem = this.enrollmentProblem(enrollment, request);
    if (problem !== null || enrollment.connectionId !== request.connectionId) {
      return errorPage('Cannot authorize', problem ?? 'This authorization request is not valid.');
    }
    const connection = this.deps.connectionsRepo.findById(request.connectionId);
    if (connection === undefined)
      return errorPage('Unavailable', 'This MCP connection no longer exists.');
    const scopes = this.grantedScopes(request, connection.scopes);
    if (scopes.length === 0)
      return errorPage(
        'Cannot authorize',
        'None of the requested permissions are allowed for this connection.',
      );

    const issued = this.deps.tokens.issueCode({
      requestId: request.id,
      client,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes,
      resource: resourceFor(issuer, connection.id),
      connectionId: connection.id,
      enrollmentId: enrollment.id,
    });
    const nowIso = this.deps.clock.now().toISOString();
    const reserveUntil = addSeconds(new Date(issued.expiresAt), 30).toISOString();
    if (
      !this.deps.connectionsRepo.reserveEnrollment(
        enrollment.id,
        issued.codeId,
        reserveUntil,
        nowIso,
      )
    ) {
      return errorPage(
        'Cannot authorize',
        'This setup password was just used or replaced. Ask your postmaster for new setup credentials.',
      );
    }
    if (!this.deps.oauth.completeRequest(request.id, nowIso)) {
      return errorPage('Already completed', 'This authorization request was already completed.');
    }
    this.deps.audit.record({
      event: 'oauth.authorization_granted',
      result: 'success',
      actor: `enrollment:${enrollment.username}`,
      connectionId: connection.id,
      mailbox: connection.mailbox,
      ip,
      details: { clientId: client.clientId, scopes: scopes.join(' ') },
    });
    return {
      kind: 'redirect',
      url: this.redirectWith(request.redirectUri, issuer, {
        code: issued.code,
        state: request.state,
      }),
    };
  }
}
