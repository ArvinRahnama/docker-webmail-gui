/**
 * The two fixed repository constants panel self-update composes every
 * image reference from (docs/design/self-update.md §2), and the two pure
 * helpers built on them. `PanelSelfUpdateApplyRequestSchema.targetVersion`
 * (`@dwg/shared`) only ever carries a bare `X.Y.Z` string — this is the
 * one place that string becomes a full `repo:tag` reference, and the
 * repository half never comes from anywhere but these two constants.
 * `operations.ts`'s handlers and `updater.ts`'s state machine both import
 * from here rather than each hardcoding the strings themselves, so the
 * two can never drift onto different repositories.
 */

export const PANEL_SERVER_REPOSITORY = 'ghcr.io/arvinrahnama/docker-webmail-gui-server';
export const PANEL_BROKER_REPOSITORY = 'ghcr.io/arvinrahnama/docker-webmail-gui-broker';

/** Composes a full pull/create reference from a fixed repository and a version string. */
export function panelImageReference(repository: string, version: string): string {
  return `${repository}:${version}`;
}

/**
 * Extracts the full `X.Y.Z` version tag for `repository` out of a set of
 * repo tags (`DockerApi.listImages()`'s own `repoTags`, which for one
 * release-tagged image includes the full version, the minor-only alias,
 * and `latest`, all pointing at the same image id — the release
 * convention docs/design/self-update.md §9.2 confirms). Returns the full
 * version only, never the minor-only or `latest` alias, since those are
 * not values `PanelSelfUpdateApplyRequestSchema.targetVersion` (or this
 * project's own tagging convention) recognises as *the* version. Returns
 * `null` — never invents a value — when no tag under this repository
 * matches that exact shape, e.g. a locally built or hand-tagged image
 * (docs/design/self-update.md §9.8).
 */
export function extractPanelVersion(
  repoTags: readonly string[],
  repository: string,
): string | null {
  const prefix = `${repository}:`;
  for (const tag of repoTags) {
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    if (/^\d+\.\d+\.\d+$/.test(version)) return version;
  }
  return null;
}
