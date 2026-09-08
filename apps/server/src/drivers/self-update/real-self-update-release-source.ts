/**
 * Real {@link SelfUpdateReleaseSourcePort} — one GitHub REST API call,
 * mirroring `real-registry-client.ts`'s shape (no client library; `undici`,
 * already a budgeted dependency, is the entire footprint).
 *
 * `GET /repos/{owner}/{repo}/releases/latest` returns GitHub's own notion
 * of "latest" (the most recent non-draft, non-prerelease release by
 * creation order) — exactly the semantics §9.1's auto-latest decision
 * wants, with no pagination or sorting to get wrong on this project's
 * side. A repository with no releases at all answers `404`, handled the
 * same as any other non-2xx: `null`, not a throw.
 *
 * Not exercised against the real GitHub API by any test in this
 * repository — there is no network access assumed for `npm test`, same
 * boundary `real-registry-client.ts` documents for itself — but it
 * type-checks, and its pure parsing helper ({@link parseVersionFromTag})
 * is unit-tested directly.
 */
import { request } from 'undici';
import type { SelfUpdateRelease, SelfUpdateReleaseSourcePort } from './types.js';

/** The project's own repository — a fixed constant, never configuration, since there is exactly one place this project's own releases could come from. */
const RELEASES_URL = 'https://api.github.com/repos/ArvinRahnama/docker-webmail-gui/releases/latest';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Strips a release tag's leading `v` and validates the remainder is a
 * bare `X.Y.Z` — this project's own tagging convention
 * (`git tag v0.1.0`/`v0.2.0`/`v0.3.0`). Returns `null` for anything that
 * does not match, deliberately: a differently-shaped tag (a pre-release,
 * a draft, a typo) must never produce a value that could reach
 * `PanelSelfUpdateApplyRequestSchema.targetVersion`'s regex as something
 * that merely *looks* like it passed validation upstream of the actual
 * check — this function is the one place that decides "is this really a
 * version", and it fails closed. Exported for direct unit testing.
 */
export function parseVersionFromTag(tagName: string): string | null {
  const withoutPrefix =
    tagName.startsWith('v') || tagName.startsWith('V') ? tagName.slice(1) : tagName;
  return /^\d+\.\d+\.\d+$/.test(withoutPrefix) ? withoutPrefix : null;
}

interface GitHubReleaseResponse {
  readonly tag_name?: unknown;
  readonly published_at?: unknown;
}

export class RealSelfUpdateReleaseSource implements SelfUpdateReleaseSourcePort {
  async resolveLatestRelease(): Promise<SelfUpdateRelease | null> {
    try {
      const response = await request(RELEASES_URL, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          // GitHub's REST API refuses unauthenticated requests with no
          // User-Agent at all (its own documented requirement) — this
          // identifies the request, nothing more; no token, no auth.
          'user-agent': 'docker-webmail-gui-self-update',
        },
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump();
        return null;
      }

      const body = (await response.body.json()) as GitHubReleaseResponse;
      if (typeof body.tag_name !== 'string' || typeof body.published_at !== 'string') return null;

      const version = parseVersionFromTag(body.tag_name);
      if (version === null) return null;

      return { version, publishedAt: body.published_at };
    } catch {
      // Network/DNS/TLS/parse failure — unreachable is Unknown, never a
      // thrown error (see this method's own doc comment on the port).
      return null;
    }
  }
}
