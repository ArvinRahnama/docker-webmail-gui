import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
