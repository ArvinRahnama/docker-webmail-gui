import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CSRF_HEADER_NAME } from '@dwg/shared';

/**
 * `api-client.ts` keeps module-scoped mutable state (the cached CSRF
 * token, the registered unauthenticated handler) deliberately — see its
 * own comments. That makes `vi.resetModules()` + a fresh dynamic import
 * per test the right tool here, rather than a reset-for-tests export that
 * would only exist to serve this file.
 */
async function freshApiClient() {
  vi.resetModules();
  return import('./api-client');
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

const okSchema = z.object({ ok: z.literal(true) });

describe('request', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves with the parsed body on a 2xx response matching the schema', async () => {
    const { request } = await freshApiClient();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await request('/api/v1/health', okSchema);

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/health',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('does not attach a CSRF header on a GET request', async () => {
    const { request } = await freshApiClient();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    await request('/api/v1/health', okSchema);

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers[CSRF_HEADER_NAME]).toBeUndefined();
  });

  it('fetches a CSRF token before a state-changing request and attaches it as the header', async () => {
    const { request } = await freshApiClient();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'secret-token-123' })) // GET /auth/csrf-token
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // the real POST

    await request('/api/v1/mail/mailboxes', okSchema, {
      method: 'POST',
      body: { address: 'a@b.test' },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [csrfUrl] = vi.mocked(fetch).mock.calls[0]!;
    expect(csrfUrl).toBe('/api/v1/auth/csrf-token');

    const [postUrl, postInit] = vi.mocked(fetch).mock.calls[1]!;
    expect(postUrl).toBe('/api/v1/mail/mailboxes');
    const headers = postInit?.headers as Record<string, string>;
    expect(headers[CSRF_HEADER_NAME]).toBe('secret-token-123');
    expect(postInit?.credentials).toBe('include');
  });

  it('skips the CSRF fetch entirely for a state-changing request with skipCsrf: true', async () => {
    // Regression test: login is a POST with no session yet to have issued
    // a CSRF token, and GET /auth/csrf-token itself requires a session
    // (auth.routes.ts) — so before `skipCsrf` existed, `login()` fetching
    // one unconditionally meant every login 401'd before its own POST was
    // ever sent. Caught by e2e/login.spec.ts, a real browser against a
    // real server; this pins the same behaviour at the unit level.
    const { request } = await freshApiClient();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    await request('/api/v1/auth/login', okSchema, {
      method: 'POST',
      body: { email: 'a@b.test', password: 'x' },
      skipCsrf: true,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/v1/auth/login');
    const headers = init?.headers as Record<string, string>;
    expect(headers[CSRF_HEADER_NAME]).toBeUndefined();
  });

  it('reuses a cached CSRF token across multiple state-changing requests', async () => {
    const { request } = await freshApiClient();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await request('/api/v1/one', okSchema, { method: 'POST' });
    await request('/api/v1/two', okSchema, { method: 'POST' });

    // One CSRF fetch, two real requests — the token was reused, not re-fetched.
    expect(fetch).toHaveBeenCalledTimes(3);
    const secondCallUrl = vi.mocked(fetch).mock.calls[2]![0];
    expect(secondCallUrl).toBe('/api/v1/two');
  });

  it('surfaces the server error envelope as an ApiError with code, message and errorId', async () => {
    const { request, ApiError } = await freshApiClient();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'That mailbox does not exist.',
            errorId: 'e_01J9X4Q2M5K8',
            details: null,
          },
        },
        { status: 404 },
      ),
    );

    const failure = await request('/api/v1/mail/mailboxes/nope', okSchema).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as InstanceType<typeof ApiError>;
    expect(apiError.code).toBe('NOT_FOUND');
    expect(apiError.errorId).toBe('e_01J9X4Q2M5K8');
    expect(apiError.message).toBe('That mailbox does not exist.');
    expect(apiError.httpStatus).toBe(404);
  });

  it('calls the registered unauthenticated handler when the server reports UNAUTHENTICATED', async () => {
    const { request, setUnauthenticatedHandler } = await freshApiClient();
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication is required.',
            errorId: 'e_01J9X4Q2M5K9',
            details: null,
          },
        },
        { status: 401 },
      ),
    );

    await expect(request('/api/v1/mail/mailboxes', okSchema)).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call the unauthenticated handler for other error codes', async () => {
    const { request, setUnauthenticatedHandler } = await freshApiClient();
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'CONFLICT', message: 'Already exists.', errorId: 'e_1', details: null } },
        { status: 409 },
      ),
    );

    await expect(
      request('/api/v1/mail/mailboxes', okSchema, { method: 'POST', body: {} }),
    ).rejects.toThrow();
    // Two fetch calls happen for the POST (CSRF token, then the request
    // itself) before the CONFLICT is surfaced; the handler still must not fire.
    expect(handler).not.toHaveBeenCalled();
  });

  it('throws an ApiClientError (with a client-generated errorId) when the response body does not match the schema', async () => {
    const { request, ApiClientError } = await freshApiClient();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ unexpected: 'shape' }));

    const failure = await request('/api/v1/health', okSchema).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiClientError);
    const clientError = failure as InstanceType<typeof ApiClientError>;
    expect(clientError.errorId).toMatch(/^client_/);
  });

  it('throws an ApiClientError when the network request itself fails', async () => {
    const { request, ApiClientError } = await freshApiClient();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const failure = await request('/api/v1/health', okSchema).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiClientError);
  });

  it('invalidates the cached CSRF token on a FORBIDDEN response so the next request re-fetches it', async () => {
    const { request } = await freshApiClient();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'stale-token' }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'FORBIDDEN',
              message: 'Invalid CSRF token.',
              errorId: 'e_2',
              details: null,
            },
          },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'fresh-token' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(request('/api/v1/one', okSchema, { method: 'POST' })).rejects.toThrow();
    await request('/api/v1/two', okSchema, { method: 'POST' });

    expect(fetch).toHaveBeenCalledTimes(4);
    const thirdCallUrl = vi.mocked(fetch).mock.calls[2]![0];
    expect(thirdCallUrl).toBe('/api/v1/auth/csrf-token');
  });
});
