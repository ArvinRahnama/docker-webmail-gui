/**
 * Sets Zod v4's `jitless` global config as this module's only side
 * effect — see `main.tsx`'s doc comment for *why* (Zod's `new
 * Function('')` JIT-capability probe trips this project's CSP).
 *
 * A separate module, imported *first* in `main.tsx`, rather than the
 * `z.config(...)` call living directly in `main.tsx`'s own body: ES
 * module evaluation runs every *imported* module's full graph to
 * completion, in source order, before the importing module's own
 * top-level code runs — so `main.tsx`'s `import App from './App'`
 * (which transitively imports `@dwg/shared`, and so constructs every
 * schema `@dwg/shared` defines at module scope, the moment Zod's own
 * JIT-capability probe actually runs) would finish evaluating, probe and
 * all, *before* a `z.config(...)` call sitting in `main.tsx`'s own body
 * ever got a chance to run — regardless of which line of that body it
 * was written on. Placing the config call in its own module and
 * importing that module before `import App` is what makes "first" real:
 * `main.tsx`'s imports are themselves evaluated in the order written, so
 * this one runs, and sets `jitless: true` on the shared
 * `globalThis.__zod_globalConfig` singleton, before `import App`'s graph
 * — and the schema construction inside it — even begins.
 */
import { z } from 'zod';

z.config({ jitless: true });
