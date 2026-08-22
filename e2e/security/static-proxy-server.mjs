#!/usr/bin/env node
/**
 * A minimal single-origin static file server + `/api` reverse proxy, for
 * exactly one purpose: SECURITY.md Part 5 check 7's second half ("the CSP
 * not broken by the real app") and the accessibility sweep both need the
 * *real, built* SPA in a *real browser*, served with the *real*
 * Content-Security-Policy header — something neither of this project's
 * two existing options can do. `playwright.config.ts`'s main harness
 * deliberately runs the Vite *dev* server (documented there: HMR's own
 * inline bootstrap script and eval-based sourcemaps are incompatible with
 * a script-src with no `unsafe-inline`/`unsafe-eval`, so testing a strict
 * CSP against dev tooling would fail on Vite's own client, not on this
 * app's code — a false signal either way). `apps/server` does not serve
 * the built SPA at all yet (`app.ts`'s own doc comment: that is M13
 * packaging work). This script is the small, test-only middle ground:
 * serve the *production build* (`vite build`'s output — no HMR, no eval,
 * no dev-only script) from one origin, with this project's actual CSP
 * header attached, proxying `/api` to a real `apps/server` instance so
 * the app is genuinely usable (login, navigate, mutate) rather than a
 * static shell.
 *
 * Deliberately dependency-free (Node built-ins only) — this is a test
 * harness, not a shipped artifact, and does not belong in any
 * workspace's `dependencies`.
 *
 * Env vars: `PORT` (own listen port), `DIST_DIR` (absolute path to
 * `apps/web/dist`), `API_PROXY_TARGET` (e.g. `http://127.0.0.1:3912`,
 * the real apps/server instance this run's `/api/*` calls forward to).
 */
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { buildCspHeaderValue } from '@dwg/shared';

const PORT = Number(process.env['PORT'] ?? '3911');
const DIST_DIR = process.env['DIST_DIR'];
const API_PROXY_TARGET = process.env['API_PROXY_TARGET'];

if (!DIST_DIR) throw new Error('static-proxy-server: DIST_DIR is required');
if (!API_PROXY_TARGET) throw new Error('static-proxy-server: API_PROXY_TARGET is required');

const apiTargetUrl = new URL(API_PROXY_TARGET);

/**
 * Every header this project's real app actually sets (`app.ts`'s
 * `registerSecurityHeaders`) — not just CSP — so a spec asserting on any
 * of them sees the real, complete production header set regardless of
 * which of the two origins (this one, or the proxied apps/server) served
 * a given response.
 */
const SECURITY_HEADERS = {
  'content-security-policy': buildCspHeaderValue(),
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function proxyToApi(req, res) {
  const target = new URL(req.url, apiTargetUrl);
  const proxyReq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`static-proxy-server: upstream API proxy error: ${String(err)}`);
  });
  req.pipe(proxyReq);
}

/** Resolves a request path to a file under DIST_DIR, refusing to leave it (defence in depth — this harness only ever serves its own build output, but a path-escaping bug in a test server would be an embarrassing thing to ship even here). */
function resolveWithinDist(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0] ?? '/');
  const resolved = normalize(join(DIST_DIR, decoded));
  if (!resolved.startsWith(DIST_DIR + sep) && resolved !== DIST_DIR) return null;
  return resolved;
}

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    proxyToApi(req, res);
    return;
  }

  const candidate = resolveWithinDist(req.url ?? '/');
  const hasRealFile = candidate !== null && existsSync(candidate) && statSync(candidate).isFile();
  // SPA fallback: any path with no file extension in its final segment
  // (an app route like `/mail/domains`, not a missing asset like
  // `/assets/typo.js`) that doesn't already exist as a real file serves
  // `index.html`, exactly like a production static-file host configured
  // for client-side routing.
  const lastSegment = (req.url ?? '/').split('/').pop() ?? '';
  const looksLikeAppRoute = !lastSegment.includes('.');
  const filePath = hasRealFile
    ? candidate
    : looksLikeAppRoute
      ? join(DIST_DIR, 'index.html')
      : null;

  if (filePath === null) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const contentType = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': contentType });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `static-proxy-server: listening on http://127.0.0.1:${PORT}, proxying /api to ${API_PROXY_TARGET}`,
  );
});
