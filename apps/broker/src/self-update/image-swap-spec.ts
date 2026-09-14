/**
 * Builds the spec `updater.ts` recreates a panel container from when it
 * swaps that container onto a new image — the captured
 * {@link RawContainerRecreateSpec} with `image` replaced **and every
 * value the container merely inherited from its old image removed**.
 *
 * **The production bug this exists to fix (1.0.0 -> 1.0.1).** A
 * container's `Config.Env`, `Config.Labels` and `Config.Cmd` — exactly
 * what `inspectContainerForRecreate` captures — are Docker's *merge* of
 * the image's own baked `ENV`/`LABEL`/`CMD` with whatever the container
 * itself set. The updater used to recreate with `{ ...plan, image:
 * target }`, which handed the old image's `DWG_VERSION=1.0.0` (and
 * `NODE_ENV`, `PATH`, the OCI version label, …) to the new container as
 * *explicit container config*. Explicit container config beats image
 * config, so the 1.0.1 container kept claiming to be 1.0.0 forever:
 * `panel.selfUpdateCheck` read the stale value and the panel offered the
 * same update again and again. The new code was running; only the
 * image-owned facts about it were pinned to the past.
 *
 * **The rule** (applied to env below; labels and cmd follow the same
 * shape). An entry of the captured container env is dropped when:
 *
 *  1. its key is in {@link IMAGE_PROVENANCE_ENV_KEYS} — whatever its
 *     value. These describe *which build of which image* this is
 *     (`DWG_VERSION`/`DWG_IMAGE_ORIGIN` from our Dockerfiles,
 *     `NODE_VERSION`/`YARN_VERSION` from the `node` base image). They are
 *     never deployment configuration: `docker/compose.yaml` and
 *     `installer/install.sh` set none of them (the installer's `.env`
 *     `DWG_VERSION` only ever selects an image *tag* and a build ARG; it
 *     is not in either service's `environment:`), nothing in either app
 *     reads the node ones, and `docker/server/Dockerfile` states outright
 *     that the DWG pair is "never a compose-level override". Dropping
 *     them unconditionally is what *heals* containers an earlier updater
 *     already polluted: there the stale value (`1.0.0`) no longer matches
 *     the image the container runs (`1.0.1`), so rule 2 alone would keep
 *     it forever.
 *  2. **or** the old image's own `Config.Env` contains the identical
 *     `KEY=VALUE` entry — i.e. the container inherited it verbatim. The
 *     new image supplies its own value for that key (or deliberately
 *     none), exactly as a fresh `docker compose up` would.
 *
 * Everything else is kept verbatim: every key the image does not define
 * at all (all of compose's `environment:` — `COOKIE_SECRET`,
 * `BROKER_SHARED_SECRET`, `BROKER_*`, `PORT`, `HOST`, `DMS_*`,
 * `PANEL_*`, `RSPAMD_*`, `ENABLE_*`, CI's
 * `DANGEROUSLY_OVERRIDE_SELF_UPDATE_REGISTRY`, …) and every key the image
 * *does* define but whose value differs (an operator override, e.g.
 * `NODE_ENV=development` or a custom `DATA_DIR`). That second case is the
 * one place this rule is deliberately conservative: a functional image key
 * (`PATH`, `NODE_ENV`, `DATA_DIR`, `BACKUP_DIR`, `STATIC_DIR`) pinned to a
 * value from an *older* image is indistinguishable, from env alone, from
 * a genuine operator override, so it is kept rather than risk silently
 * discarding real configuration. No release so far has changed any of
 * those values (every `v*` tag's two Dockerfiles bake identical ones on
 * the identical base-image digest), so on every real install the
 * pollution the 1.0.0/1.0.1 updaters left behind is removed completely by
 * rules 1 and 2 on the next update.
 *
 * Labels get the same two rules: an `org.opencontainers.image.*` label is
 * image provenance by the OCI image spec's own definition (the release
 * workflow stamps `…image.version`/`…image.revision` on every published
 * image) and is always dropped; any other label identical to the old
 * image's is inherited and dropped; container-level labels
 * (`com.docker.compose.*`, anything an operator added) are kept. `cmd` is
 * dropped (left to the new image) only when it is identical to the old
 * image's own `CMD` — `docker/compose.yaml` sets no `command:`, so this
 * keeps a future release that changes its `CMD` from being started with
 * the previous release's command.
 *
 * When the old image could not be inspected (`oldImage === null`), only
 * the unconditional provenance drops apply and `cmd` is kept — the
 * previous clone-everything behaviour for everything else, which is a
 * degraded but safe result (it still fixes the reported version).
 *
 * **Rollback never goes through this function.** `updater.ts` rolls back
 * from the captured spec itself, untouched — the full original env
 * included — so a rollback recreates exactly the container that existed
 * before (same image id, so every inherited value is back to being
 * redundant with it anyway).
 */
import type { RawContainerRecreateSpec, RawImageConfig } from '../docker-types.js';

/** Env keys that describe the image build itself, never a deployment — see this file's header, rule 1. */
export const IMAGE_PROVENANCE_ENV_KEYS: ReadonlySet<string> = new Set([
  'DWG_VERSION',
  'DWG_IMAGE_ORIGIN',
  'NODE_VERSION',
  'YARN_VERSION',
]);

/** Label-key prefix reserved by the OCI image spec for annotations describing the image — see this file's header. */
export const IMAGE_PROVENANCE_LABEL_PREFIX = 'org.opencontainers.image.';

/** Docker's own `KEY=VALUE` convention; an entry without `=` is its whole self as the key. */
function envKey(entry: string): string {
  const separatorIndex = entry.indexOf('=');
  return separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
}

/** Rules 1 and 2 of this file's header, applied to one container env. */
export function withoutImageInheritedEnv(
  containerEnv: readonly string[],
  oldImage: RawImageConfig | null,
): string[] {
  const inherited = new Set(oldImage?.env ?? []);
  return containerEnv.filter(
    (entry) => !IMAGE_PROVENANCE_ENV_KEYS.has(envKey(entry)) && !inherited.has(entry),
  );
}

function withoutImageInheritedLabels(
  containerLabels: Readonly<Record<string, string>>,
  oldImage: RawImageConfig | null,
): Record<string, string> {
  const imageLabels = oldImage?.labels ?? {};
  return Object.fromEntries(
    Object.entries(containerLabels).filter(
      ([key, value]) =>
        !key.startsWith(IMAGE_PROVENANCE_LABEL_PREFIX) &&
        !(Object.hasOwn(imageLabels, key) && imageLabels[key] === value),
    ),
  );
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === b[index]);
}

function withoutImageInheritedCmd(
  containerCmd: readonly string[] | null,
  oldImage: RawImageConfig | null,
): readonly string[] | null {
  if (containerCmd === null || oldImage === null || oldImage.cmd === null) return containerCmd;
  return sameArgv(containerCmd, oldImage.cmd) ? null : containerCmd;
}

/**
 * The spec to create the *new* container from: `captured` with `image`
 * set to `targetImage` and everything inherited from `oldImage` removed
 * (this file's header). `hostConfig`/`networkingConfig`/`name` are
 * untouched — those are never merged from an image.
 */
export function buildImageSwapSpec(
  captured: RawContainerRecreateSpec,
  oldImage: RawImageConfig | null,
  targetImage: string,
): RawContainerRecreateSpec {
  return {
    ...captured,
    image: targetImage,
    env: withoutImageInheritedEnv(captured.env, oldImage),
    labels: withoutImageInheritedLabels(captured.labels, oldImage),
    cmd: withoutImageInheritedCmd(captured.cmd, oldImage),
  };
}
