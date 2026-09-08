/**
 * Deterministic {@link SelfUpdateReleaseSourcePort} — the development/test
 * default (`create-self-update-release-source.ts`), touching no network.
 * Mirrors `fake-registry-client.ts`'s reasoning exactly: a fixed,
 * invented fixture (labelled as such, per AGENT_BRIEF.md §3 rule 8 — there
 * is no real GitHub Releases page to capture a fixture from that this
 * project controls the future contents of). Deliberately a version well
 * ahead of any real `DWG_VERSION` this codebase has shipped, so "an
 * update is available" is the observable default in development — the
 * more interesting state to build the UI against — and a test wanting
 * "already up to date" overrides this with its own stub instead.
 */
import type { SelfUpdateRelease, SelfUpdateReleaseSourcePort } from './types.js';

export const FIXTURE_LATEST_VERSION = '9.9.9';
export const FIXTURE_LATEST_PUBLISHED_AT = '2026-01-01T00:00:00.000Z';

export class FakeSelfUpdateReleaseSource implements SelfUpdateReleaseSourcePort {
  async resolveLatestRelease(): Promise<SelfUpdateRelease | null> {
    return { version: FIXTURE_LATEST_VERSION, publishedAt: FIXTURE_LATEST_PUBLISHED_AT };
  }
}
