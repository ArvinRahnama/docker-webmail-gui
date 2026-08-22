/**
 * The one Content-Security-Policy definition this project has — matches
 * SECURITY.md §4.2: no `unsafe-eval` anywhere, no CDN anywhere, and no
 * `unsafe-inline` for anything *except* the one narrow, documented
 * exception below. Previously this directive set was written out twice
 * by hand (once as `apps/server/src/app.ts`'s `@fastify/helmet` config,
 * once as prose in SECURITY.md), which is exactly the shape of thing
 * that drifts — a directive changed in one place and not the other would
 * leave the doc lying, or the app more permissive than documented, with
 * nothing to notice either way. `apps/server/src/app.ts` builds its
 * Helmet config from this; `e2e/security/csp.spec.ts` builds its
 * expected header value from the same source, so the deployed policy and
 * the thing verifying it cannot independently drift from each other,
 * only both be wrong the same way (a lesser but bounded risk, at that
 * point caught by the `unsafe-eval`/CDN checks alongside it).
 *
 * Ordered as SECURITY.md §4.2 lists it. Order carries no CSP meaning; kept
 * stable purely so a diff of this file reads as a real change, not a
 * reshuffle.
 *
 * `style-src-elem` carries `'unsafe-inline'` — the one deliberate,
 * bounded loosening in this policy, found necessary in M12
 * (`e2e/security/csp.spec.ts`) once a real browser was actually
 * enforcing this policy against the real bundle. `sonner` (the toast
 * library `App.tsx` mounts once, used from ~20 call sites) injects its
 * entire base stylesheet via `document.createElement('style')` at
 * runtime rather than shipping an importable CSS file with a nonce hook
 * — confirmed against its source (`node_modules/sonner/dist/index.mjs`)
 * and its current major version's public API, neither offers a way to
 * attach a CSP nonce to that element. Replacing it would touch ~20
 * files for a toast library, not a security-relevant one; loosening
 * `script-src` (arbitrary code execution) to work around a styling
 * library would be the wrong trade in the other direction. `style-src`
 * itself (governing `<link rel=stylesheet>`/`@import`, and the fallback
 * for `style-src-attr`, which stays unset — nothing needs inline `style=`
 * *attributes*, and Radix's own positioning goes through the
 * `HTMLElement.style` CSSOM API, which no CSP directive restricts at
 * all) is deliberately left at `'self'` only, specifically so this
 * exception cannot silently widen if a directive is ever conflated with
 * its sibling.
 */
export const CSP_DIRECTIVES: ReadonlyArray<readonly [name: string, values: readonly string[]]> = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'"]],
  ['style-src-elem', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:']],
  ['font-src', ["'self'"]],
  ['connect-src', ["'self'"]],
  ['frame-ancestors', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'self'"]],
  ['object-src', ["'none'"]],
];

/** The literal `Content-Security-Policy` header value — `directive value1 value2; directive2 …`, semicolon-joined with no trailing separator. */
export function buildCspHeaderValue(): string {
  return CSP_DIRECTIVES.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** kebab-case (`script-src`) -> the camelCase Helmet's `contentSecurityPolicy.directives` option expects (`scriptSrc`). */
function toHelmetDirectiveKey(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** `@fastify/helmet`'s `contentSecurityPolicy.directives` shape, derived from {@link CSP_DIRECTIVES} — see `apps/server/src/app.ts`. */
export function buildHelmetCspDirectives(): Record<string, readonly string[]> {
  const directives: Record<string, readonly string[]> = {};
  for (const [name, values] of CSP_DIRECTIVES) {
    directives[toHelmetDirectiveKey(name)] = values;
  }
  return directives;
}
