import { VERSION } from '@dwg/shared';

/**
 * Bare placeholder root component — no design system, routing, or data
 * fetching yet. Those land at M6 (frontend foundation), per
 * IMPLEMENTATION_PLAN.md §3 and the design system in UX_ARCHITECTURE.md.
 * This exists only so `apps/web` builds and runs today.
 */
export default function App() {
  return (
    <main>
      <h1>Docker Webmail GUI</h1>
      <p>Under active development (shared v{VERSION}).</p>
    </main>
  );
}
