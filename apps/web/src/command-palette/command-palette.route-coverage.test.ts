/**
 * IMPLEMENTATION_PLAN.md M12: `command-palette.tsx`'s own doc comment
 * claims its `NAV_GROUPS` table is "exhaustive over `App.tsx`'s route
 * table" — every list-level (non-`:param`) route the app shell nav
 * reaches. That claim already drifted false once before this test
 * existed: the Rspamd page shipped a real route in `App.tsx` (M8) that
 * `NAV_GROUPS` did not gain until a much later commit closed the gap
 * (`1f2953b`, per the M11 handoff notes this milestone inherited). A
 * comment is not a test; a comment that already lied once is a bug
 * waiting to recur on the next new page.
 *
 * This file makes the claim mechanical: it reads `App.tsx`'s source
 * directly (there is no runtime route registry to import — React Router
 * routes are JSX, not data, in this codebase) and extracts every
 * list-level route registered inside the `<Route element={<AppLayout
 * />}>` block (the routes that get the shared nav shell, and so are the
 * only ones a "jump to…" palette entry could sensibly target — `/login`
 * and `/change-password` sit outside that block by design and are
 * correctly absent from `NAV_GROUPS`). It then diffs that set against
 * `NAV_GROUPS`'s flattened `to` values, in both directions: a route
 * `App.tsx` has that the palette does not (a silent gap, the Rspamd bug's
 * shape) and a palette entry pointing at a path `App.tsx` no longer
 * registers (a dead/stale entry, the same bug in reverse).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from './command-palette.js';

// Not `new URL('../App.tsx', import.meta.url)`: under this workspace's
// jsdom test environment, `import.meta.url` does not resolve as a
// `file:` URL WHATWG relative resolution accepts, and throws. Deriving
// the directory with `node:path` instead sidesteps that entirely.
const APP_TSX_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx');

/** Every `path="..."` on a `<Route>` registered inside the `<Route element={<AppLayout />}>` block — the shared-nav-shell routes `App.tsx` itself groups together (its own doc comment: "Everything under `Route element={<AppLayout />}` shares the top nav shell"). */
function extractAppLayoutRoutePaths(): readonly string[] {
  const source = readFileSync(APP_TSX_PATH, 'utf8');

  const layoutStart = source.indexOf('<Route element={<AppLayout />}>');
  if (layoutStart === -1) {
    throw new Error(
      'command-palette.route-coverage.test.ts: App.tsx no longer has a <Route element={<AppLayout />}> block at all — this test needs updating, not silently skipping.',
    );
  }
  const layoutEnd = source.indexOf('</Route>', layoutStart);
  if (layoutEnd === -1) {
    throw new Error(
      'command-palette.route-coverage.test.ts: could not find the closing </Route> for the AppLayout block.',
    );
  }
  const block = source.slice(layoutStart, layoutEnd);

  const paths: string[] = [];
  const pathPattern = /<Route\s+path="([^"]+)"/g;
  for (const match of block.matchAll(pathPattern)) {
    paths.push(match[1]!);
  }
  return paths;
}

/** Detail/dynamic routes (`:domain`, `:address`, …) are deliberately not palette nav entries — live entity search covers them instead (this file's own module doc comment). Only list-level routes belong in `NAV_GROUPS`. */
function isListLevelRoute(path: string): boolean {
  return !path.includes(':');
}

describe('command palette NAV_GROUPS is exhaustive over App.tsx (both directions)', () => {
  it('extracted at least a representative, known set of routes — guards against the parser silently finding nothing', () => {
    const paths = extractAppLayoutRoutePaths();
    expect(paths).toContain('/');
    expect(paths).toContain('/mail/domains');
    expect(paths).toContain('/security/rspamd');
    expect(paths.length).toBeGreaterThan(20);
  });

  it("every list-level App.tsx route has a NAV_GROUPS entry (the Rspamd bug's shape)", () => {
    const appRoutes = extractAppLayoutRoutePaths().filter(isListLevelRoute);
    const navPaths = new Set(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to)));

    const missing = appRoutes.filter((path) => !navPaths.has(path));
    expect(missing).toEqual([]);
  });

  it('every NAV_GROUPS entry points at a route App.tsx actually registers (no stale/dead entry)', () => {
    const appRoutes = new Set(extractAppLayoutRoutePaths());
    const navPaths = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));

    const stale = navPaths.filter((path) => !appRoutes.has(path));
    expect(stale).toEqual([]);
  });

  it('NAV_GROUPS has no duplicate destination — each real page reachable exactly one way', () => {
    const navPaths = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));
    expect(new Set(navPaths).size).toBe(navPaths.length);
  });
});
