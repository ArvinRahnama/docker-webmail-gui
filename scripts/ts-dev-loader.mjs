/**
 * Custom ESM resolve hook that lets `apps/server` and `apps/broker` run
 * straight from TypeScript source in development — no `tsc --build`, no
 * `dist/`, no new dependency.
 *
 * The problem this solves: `tsconfig.base.json` mandates NodeNext modules,
 * so every relative import in this codebase is written with a `.js`
 * specifier (`import './config.js'`) even though the file on disk is
 * `config.ts` — that's the whole point of NodeNext resolution, and it's
 * exactly what `tsc --build` expects and rewrites correctly on emit. But
 * `node --watch src/index.ts` (the "dev" script both workspaces declare)
 * asks *Node's own* module loader to resolve those same `.js` specifiers,
 * and Node's loader has no idea `config.js` is supposed to mean
 * `config.ts` — it just looks for a literal `config.js` on disk, finds
 * nothing (compiled output only exists after a build), and the process
 * dies with `ERR_MODULE_NOT_FOUND` before it ever starts. Confirmed by
 * running it directly on Node 24.19.0.
 *
 * This hook is the missing half: a relative `.js` specifier that doesn't
 * resolve to a real file is retried as `.ts`. That's all it does — actual
 * type stripping/transformation is Node's own built-in TypeScript support
 * (`--experimental-transform-types`; `--experimental-strip-types` alone
 * isn't enough, because it can erase type *annotations* but can't
 * transform semantic sugar like this codebase's constructor parameter
 * properties, e.g. `constructor(private readonly db: Database)`), enabled
 * by the `dev` scripts that load this file, not by anything here.
 *
 * `packages/shared` (and any other bare-specifier import, e.g.
 * `@dwg/shared`) is untouched — those resolve normally through
 * node_modules to that package's own `dist/`, which still needs a real
 * build. That's an intentional, unrelated boundary: `packages/shared` is
 * a dependency of both workspaces this loader serves, not something this
 * loader is asked to source-run — build it once (`npm run build --workspace
 * packages/shared`, or let either workspace's own build cascade to it via
 * project references) before starting either `dev` script.
 *
 * Registered via `--experimental-loader` (still supported on Node 24.19.0;
 * prints its own "may be removed" notice, which is exactly as informative
 * as it looks and safe to ignore).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @type {import('node:module').ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.') || !specifier.endsWith('.js')) {
    return nextResolve(specifier, context);
  }

  const tsSpecifier = `${specifier.slice(0, -'.js'.length)}.ts`;

  let result;
  try {
    result = await nextResolve(specifier, context);
  } catch {
    return nextResolve(tsSpecifier, context);
  }

  // A successful resolve() is a claim, not a guarantee the file is real —
  // defend against it anyway rather than trust that claim blindly.
  if (!existsSync(fileURLToPath(result.url))) {
    return nextResolve(tsSpecifier, context);
  }
  return result;
}
