/**
 * The one Content-Security-Policy definition this project has — matches
 * SECURITY.md §4.2 exactly: no `unsafe-inline`, no `unsafe-eval`, no CDN.
 * Previously this directive set was written out twice by hand (once as
 * `apps/server/src/app.ts`'s `@fastify/helmet` config, once as prose in
 * SECURITY.md), which is exactly the shape of thing that drifts — a
 * directive changed in one place and not the other would leave the doc
 * lying, or the app more permissive than documented, with nothing to
 * notice either way. `apps/server/src/app.ts` builds its Helmet config
 * from this; `e2e/security/csp.spec.ts` builds its expected header value
 * from the same source, so the deployed policy and the thing verifying it
 * cannot independently drift from each other, only both be wrong the same
 * way (a lesser but bounded risk, at that point caught by the two
 * `unsafe-`/CDN checks alongside it).
 *
 * Ordered as SECURITY.md §4.2 lists it. Order carries no CSP meaning; kept
 * stable purely so a diff of this file reads as a real change, not a
 * reshuffle.
 */
export const CSP_DIRECTIVES: ReadonlyArray<readonly [name: string, values: readonly string[]]> = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'"]],
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
