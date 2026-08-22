/**
 * SECURITY.md Part 5 check 9: "Authorization enforced server-side on
 * every mutating route."
 *
 * A hand-maintained list of routes would drift the moment a new one is
 * added without a matching entry — precisely the failure mode M12's brief
 * calls out by name. This file instead asks the *running app* what
 * routes it actually has, via Fastify's own `printRoutes({ commonPrefix:
 * false })` tree (there is no public, structured "list every route" API
 * on a Fastify instance — `parseRoutes` below reconstructs full paths
 * from that tree's indentation and per-node text, verified against the
 * app's full, real route table: `printRoutes`'s own header comment in
 * `app.ts`'s dependency, and manually cross-checked against this app's
 * ~100 registered routes while writing this file), then, for every
 * mutating route (`POST`/`PUT`/`PATCH`/`DELETE`) it finds:
 *
 *  - sends it with **no session cookie at all** and asserts `401
 *    UNAUTHENTICATED` — proving `requireSession` genuinely gates it,
 *    not merely that the route happens to fail some other way first;
 *  - sends it **with a valid session but no CSRF header** and asserts
 *    `403 FORBIDDEN` — the same proof for `requireCsrf`.
 *
 * Both checks run before any route-specific business logic could run
 * (`auth.middleware.ts`'s own doc comment: `requireCsrf`/
 * `requirePermission` both read `request.auth`, so a route's
 * `preHandler` array must always list `requireSession` first) — a
 * capability-gated or not-yet-existing resource behind an unprotected
 * route would still 401/403 here, never a 404 or a 200, because the
 * guard never lets the handler body run at all.
 *
 * The one intentional exception is `POST /api/v1/auth/login` — the
 * route whose entire purpose is to be reachable without a session yet.
 * Nothing else is exempted. If a future route legitimately needs to be
 * public, it must be added to `PUBLIC_MUTATING_ROUTES` explicitly, with
 * a reason — the same "no silent exception" discipline
 * `docker-socket-isolation.security.test.ts` and
 * `command-injection.security.test.ts` already apply to their own
 * manifests.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from '@dwg/shared';
import { SESSION_COOKIE_NAME } from '../modules/auth/auth.middleware.js';
import { loginAs, setUpSecurityApp } from '../modules/security/security-test-harness.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes deliberately reachable without an existing session, and why. */
const PUBLIC_MUTATING_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/v1/auth/login', // the route that *creates* the session every other mutating route requires
]);

interface RouteEntry {
  readonly method: string;
  readonly path: string;
}

/**
 * Reconstructs `{ method, path }` pairs from `printRoutes({ commonPrefix:
 * false })`'s tree text. `find-my-way`'s `prettyPrintTree` (the library
 * behind `printRoutes`) only emits a tree key at a leaf or branching
 * node, resetting the accumulated prefix to `''` each time — so a
 * node's full path is the *concatenation* of every ancestor's own key
 * text, which is exactly what tracking one cumulative string per
 * indentation depth reproduces. Each 4-character group of `'│   '` or
 * `'    '` is one level of indentation; the line's connector
 * (`'├── '`/`'└── '`) marks where the node's own text starts.
 */
function parseRoutes(printed: string): readonly RouteEntry[] {
  const stack: string[] = [];
  const results: RouteEntry[] = [];

  for (const rawLine of printed.split('\n')) {
    if (rawLine.trim().length === 0) continue;

    let rest = rawLine;
    let depth = 0;
    while (rest.startsWith('│   ') || rest.startsWith('    ')) {
      rest = rest.slice(4);
      depth += 1;
    }
    if (!rest.startsWith('├── ') && !rest.startsWith('└── ')) {
      throw new Error(
        `route-authorization: unparseable printRoutes line: ${JSON.stringify(rawLine)}`,
      );
    }
    rest = rest.slice(4);

    const methodMatch = /^(.*) \(([^)]*)\)$/.exec(rest);
    const segment = methodMatch ? methodMatch[1]! : rest;
    const methodsPart = methodMatch ? methodMatch[2]! : null;

    const parentPath = depth === 0 ? '' : (stack[depth - 1] ?? '');
    const fullPath = parentPath + segment;
    stack[depth] = fullPath;
    stack.length = depth + 1;

    if (methodsPart !== null) {
      for (const method of methodsPart.split(',').map((m) => m.trim())) {
        results.push({ method, path: fullPath });
      }
    }
  }
  return results;
}

/** Replaces every `:param` segment with a fixed, harmless placeholder — the route's own validation (or lack of it) is not this file's concern; only whether the auth guard runs before that validation is. */
function fillParams(path: string): string {
  return path.replace(/:[^/]+/g, 'placeholder-value');
}

describe('route enumeration sanity', () => {
  it('finds a representative, known set of routes — guards against the parser silently returning nothing', async () => {
    const { app } = await setUpSecurityApp();
    try {
      const routes = parseRoutes(app.printRoutes({ commonPrefix: false }));
      const paths = new Set(routes.map((r) => `${r.method} ${r.path}`));
      expect(paths.has('GET /api/v1/health')).toBe(true);
      expect(paths.has('POST /api/v1/auth/login')).toBe(true);
      expect(paths.has('POST /api/v1/mailboxes')).toBe(true);
      expect(paths.has('DELETE /api/v1/backups/:id')).toBe(true);
      expect(routes.length).toBeGreaterThan(80);
    } finally {
      await app.close();
    }
  });
});

describe('every mutating route requires a valid session', () => {
  it('rejects every non-exempt POST/PUT/PATCH/DELETE route with no session cookie at all', async () => {
    const { app } = await setUpSecurityApp();
    try {
      const routes = parseRoutes(app.printRoutes({ commonPrefix: false }));
      const mutating = routes.filter((r) => MUTATING_METHODS.has(r.method));
      expect(mutating.length).toBeGreaterThan(20); // sanity: the filter itself found something

      const failures: string[] = [];
      for (const route of mutating) {
        const key = `${route.method} ${route.path}`;
        if (PUBLIC_MUTATING_ROUTES.has(key)) continue;

        const response = await app.inject({
          method: route.method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: fillParams(route.path),
          headers: { 'sec-fetch-site': 'same-origin' },
          payload: {},
        });
        if (response.statusCode !== 401) {
          failures.push(`${key} -> ${response.statusCode} (expected 401)`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('every mutating route requires the CSRF header even with a valid session', () => {
  it('rejects every non-exempt POST/PUT/PATCH/DELETE route with a session cookie but no CSRF header', async () => {
    const { app } = await setUpSecurityApp();
    try {
      const auth = await loginAs(app);
      const routes = parseRoutes(app.printRoutes({ commonPrefix: false }));
      const mutating = routes.filter((r) => MUTATING_METHODS.has(r.method));

      const failures: string[] = [];
      for (const route of mutating) {
        const key = `${route.method} ${route.path}`;
        if (PUBLIC_MUTATING_ROUTES.has(key)) continue;

        const response = await app.inject({
          method: route.method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: fillParams(route.path),
          cookies: { [SESSION_COOKIE_NAME]: auth.token },
          headers: { 'sec-fetch-site': 'same-origin' },
          payload: {},
        });
        if (response.statusCode !== 403) {
          failures.push(`${key} -> ${response.statusCode} (expected 403)`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('the same route succeeds past the CSRF guard once the header is present — proving the 403s above are the guard, not a broken route', async () => {
    const { app } = await setUpSecurityApp();
    try {
      const auth = await loginAs(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/mailboxes',
        cookies: { [SESSION_COOKIE_NAME]: auth.token },
        headers: { 'sec-fetch-site': 'same-origin', [CSRF_HEADER_NAME]: auth.csrfToken },
        payload: { email: 'csrf-control@example.com', password: 'a-perfectly-good-password-123' },
      });
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    } finally {
      await app.close();
    }
  });
});
