/**
 * Deterministic {@link RegistryClientPort} — the development/test default
 * (`create-registry-client.ts`), touching no network. Fixed, invented
 * fixture digest (labelled as such, per AGENT_BRIEF.md §3 rule 8): there
 * is no real registry reachable from this environment to capture one
 * from. Always reports a *different* digest than the fixture broker's
 * current image id (`drivers/broker/fixtures/containers.ts`), so
 * "update available" is the observable default — the more interesting
 * state to develop the UI against — and a test that wants "already up to
 * date" overrides this with its own stub instead.
 */
import type { RegistryClientPort } from './types.js';

/** Deliberately shaped like a real sha256 digest (64 lowercase hex chars, obviously patterned rather than random) so anything downstream that pattern-matches on digest shape keeps working — not a captured value. */
export const FIXTURE_AVAILABLE_DIGEST = `sha256:${'fedcba9876543210'.repeat(4)}`;

export class FakeRegistryClient implements RegistryClientPort {
  async resolveTagDigest(_imageReference: string): Promise<string | null> {
    return FIXTURE_AVAILABLE_DIGEST;
  }
}
