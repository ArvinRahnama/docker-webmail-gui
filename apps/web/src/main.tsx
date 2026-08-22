import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Must be the first import in this file, before `./App` — see this
// module's own doc comment for why import *order* (not just presence)
// is load-bearing here. Zod v4 probes `new Function('')` once (memoized)
// to decide whether it can use a faster, codegen-based validation path;
// its own source calls this out by name: "strict CSPs report the caught
// `new Function` as a `securitypolicyviolation` even though the throw is
// swallowed." Found by `e2e/security/csp.spec.ts` (M12): every route
// triggered a `script-src` violation from exactly this probe, the
// moment `@dwg/shared`'s zod schemas were constructed. `jitless` skips
// the probe entirely rather than merely swallowing the violation it
// causes — this project's CSP has no `unsafe-eval`, on purpose
// (SECURITY.md §4.2), so the fix is telling Zod not to try, not
// loosening the policy. Web-only: apps/server's own zod usage runs in
// Node, which has no CSP to violate and every reason to keep the faster
// path — see zod-jitless.ts's own doc comment for why it isn't shared.
import './zod-jitless';
import App from './App';
// The app's entire design system — Tailwind v4 (`@import 'tailwindcss'`),
// design tokens, and self-hosted fonts (UX_ARCHITECTURE.md §3-4) — lives
// behind this one import. Found missing during M12 while building the
// first harness that actually renders this app in a real browser: nothing
// in the module graph reached `styles/index.css` before this line, so the
// shipped bundle carried zero CSS. `styles/tokens.contrast.test.ts` never
// caught it because it parses the token file's source text directly
// rather than loading it into a page; every Vitest/jsdom component test
// and every prior Playwright spec asserts DOM structure and text, not
// applied styling, so a fully unstyled app still passed all of them.
import './styles/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root was not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
