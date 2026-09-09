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
 *
 * {@link extractBakedImageFacts} is the SU-E addition (docs/design/
 * self-update.md §9.8): the panel's own version *and* whether it was
 * installed from a registry-pulled image or built locally from source,
 * read from a container's baked `DWG_VERSION`/`DWG_IMAGE_ORIGIN`
 * environment entries (`docker/server/Dockerfile`,
 * `docker/broker/Dockerfile` — build ARGs turned into image `ENV`, never
 * a compose-level override, so an operator cannot casually flip a local
 * build's reported origin by editing `.env`). This replaces the previous
 * `extractPanelVersion(repoTags, …)` join for `panel.selfUpdateCheck`
 * specifically: `docker/compose.yaml`'s own header already notes that a
 * pulled and a locally-built image end up under the *identical* tag
 * (both `image:` and `build:` name the same reference), so the tag alone
 * can never answer "was this actually published, or built right here" —
 * only a value baked into the image itself can. `extractPanelVersion`
 * remains exactly as it was for its one other caller, `updater.ts`'s
 * `resolveFromVersion` (recovering a rollback plan's *historical*
 * version from an already-captured spec's digest — an unrelated
 * question with no "was this genuinely published" implication).
 */

export const PANEL_SERVER_REPOSITORY = 'ghcr.io/arvinrahnama/docker-webmail-gui-server';
export const PANEL_BROKER_REPOSITORY = 'ghcr.io/arvinrahnama/docker-webmail-gui-broker';

/**
 * Applies `BrokerConfig.dangerouslyOverrideSelfUpdateRegistry` (SU-F,
 * CI-only — see that field's own doc comment in `../config.ts`) to one
 * of the two constants above. `null` (every real deployment) returns
 * `defaultRepository` unchanged. When set, replaces only the registry
 * *host* portion — everything up to and including the last `/` — never
 * the fixed repository *name* suffix (`docker-webmail-gui-server` /
 * `-broker`): the override can redirect *where* the same two well-known
 * images are fetched from, never *which* image name gets composed.
 * `operations.ts`'s `handlePanelSelfUpdateApply` is the only caller —
 * `panel.selfUpdateCheck` never resolves a repository at all any more
 * (SU-E's `extractBakedImageFacts`), and `updater.ts`'s
 * `resolveFromVersion` intentionally keeps searching the real,
 * unoverridden `PANEL_SERVER_REPOSITORY` (recovering a rollback plan's
 * historical version, not composing a pull target).
 */
export function resolvePanelRepository(
  defaultRepository: string,
  registryOverride: string | null,
): string {
  if (registryOverride === null) return defaultRepository;
  const name = defaultRepository.slice(defaultRepository.lastIndexOf('/') + 1);
  return `${registryOverride}/${name}`;
}

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

/**
 * The inverse of {@link panelImageReference} for a reference this project
 * itself just composed — a plain split, not a search, since the caller
 * already knows the exact reference it built (unlike
 * {@link extractPanelVersion}, which searches an *externally reported*
 * tag list for the one matching entry). Used by `updater.ts` to recover
 * `toVersion` for its status-file report from `UpdaterTarget.serverImageRef`.
 */
export function versionFromReference(reference: string): string {
  return reference.slice(reference.lastIndexOf(':') + 1);
}

/** The two states a panel container's image can honestly claim (docs/design/self-update.md §9.8). `'registry'` only ever comes from the release workflow's own `--build-arg`; every other build — a plain `docker build`, `docker compose build`, the installer's `DWG_IMAGE_MODE=build` path — leaves the Dockerfile's own default in place. */
export const DWG_IMAGE_ORIGINS = ['registry', 'source'] as const;
export type DwgImageOrigin = (typeof DWG_IMAGE_ORIGINS)[number];

/** What {@link extractBakedImageFacts} recovers from one container's baked env — either field is `null`, never fabricated, when the corresponding entry is absent or does not parse (e.g. an image built before this baking existed at all, which is correctly treated as "cannot self-update", not guessed at). */
export interface BakedImageFacts {
  readonly version: string | null;
  readonly origin: DwgImageOrigin | null;
}

const DWG_VERSION_ENV_KEY = 'DWG_VERSION';
const DWG_IMAGE_ORIGIN_ENV_KEY = 'DWG_IMAGE_ORIGIN';

/**
 * Reads a container's baked `DWG_VERSION`/`DWG_IMAGE_ORIGIN` straight out
 * of its own `env` (`RawContainerRecreateSpec.env` — Docker's own
 * `KEY=VALUE` convention, `docker inspect`'s `Config.Env`). Deliberately
 * takes the *whole* env array and scans it, rather than assuming a fixed
 * index: Docker itself is the one that merges an image's baked `ENV`
 * with any container-level override into this single final list, and
 * this function has no reason to re-implement that merge — it only ever
 * sees the result Docker already produced.
 */
export function extractBakedImageFacts(env: readonly string[]): BakedImageFacts {
  let version: string | null = null;
  let origin: DwgImageOrigin | null = null;

  for (const entry of env) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);

    if (key === DWG_VERSION_ENV_KEY && /^\d+\.\d+\.\d+$/.test(value)) {
      version = value;
    } else if (
      key === DWG_IMAGE_ORIGIN_ENV_KEY &&
      (DWG_IMAGE_ORIGINS as readonly string[]).includes(value)
    ) {
      origin = value as DwgImageOrigin;
    }
  }

  return { version, origin };
}
