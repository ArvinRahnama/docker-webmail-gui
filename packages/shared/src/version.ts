/**
 * Application version, exposed by the health endpoint (ARCHITECTURE.md
 * §7.1) and sourced from the *repository root* `package.json`'s
 * `"version"` field — that field is this monorepo's single source of
 * truth for "the application's" version (as opposed to this package's
 * own `@dwg/shared` version, which could in principle drift from it).
 *
 * A static JSON import, not a runtime `fs.readFileSync`: this module is
 * consumed by `apps/web` too, which is a *browser* bundle — `node:fs`
 * has no browser equivalent. A JSON import is resolved by the bundler
 * (Vite) or the compiler/Node loader at build/load time in every
 * consumer, so the version ends up inlined as a plain string with no
 * runtime filesystem access anywhere, Node or browser alike.
 *
 * The relative path reaches three directories up from this file (out of
 * `packages/shared/src/`, or equally out of the compiled `dist/` — both
 * sit at the same depth) to the repository root. `@dwg/shared` is a
 * private, workspace-only package, never published to a registry, so
 * relying on this repository's fixed layout is safe.
 */
import packageJson from '../../../package.json' with { type: 'json' };

/** The application's version number, e.g. `"0.1.0"`. Part of the health response. */
export const APP_VERSION: string = packageJson.version;
