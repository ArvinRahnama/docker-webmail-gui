/**
 * The panel self-update state machine (docs/design/self-update.md §1,
 * §4) — a plain, dependency-injected function, never tested by literally
 * spawning a container. It runs *inside* the detached updater container
 * `operations.ts`'s `panel.selfUpdateApply` handler launches
 * (`updater-entrypoint.ts` is the thin script that actually invokes this
 * against a real `DockerApi`), which is what lets it recreate `dwg-broker`
 * itself: that container is a separate process from whatever launched it,
 * so tearing down "the container currently running this code" partway
 * through is no longer a problem — see the design doc's §1 for why
 * recreating `dwg-broker` specifically cannot happen from inside
 * `dwg-broker`'s own request-handling process.
 *
 * Sequence, exactly as designed:
 *
 *  1. Pull both target images. Either failing aborts here — nothing has
 *     been touched yet, a clean no-op.
 *  2. Resolve both containers' *current* ids by name (never trusting an
 *     id handed in at launch time, in case something changed between
 *     `panel.selfUpdateApply` returning and this process actually
 *     running) and capture both containers' full recreate specs — both,
 *     up front, before either is touched. This ordering is deliberate:
 *     capturing lazily (only when about to replace a given container)
 *     would leave no rollback plan for a container already replaced by
 *     the time a *later* step fails.
 *  3. Recreate `dwg-server`, poll its health, bounded. A failure rolls
 *     `dwg-server` back to its captured spec/image and stops here —
 *     `dwg-broker` was never touched, so there is nothing to unwind on
 *     that side.
 *  4. Recreate `dwg-broker` the same way. A failure here rolls back
 *     *both* containers, never `dwg-broker` alone — `dwg-server` is
 *     already on the new version at this point, and this project treats
 *     the two as released and run in lockstep (`docker/compose.yaml`'s
 *     own "never possible for the two tiers to silently drift" framing,
 *     applied here at runtime, not just at build time).
 *  5. Both healthy -> success.
 */
import type { DockerApi, RawContainerRecreateSpec } from '../docker-types.js';
import {
  PANEL_SERVER_REPOSITORY,
  extractPanelVersion,
  versionFromReference,
} from './image-refs.js';

/** Matches `server-controls.tsx`'s `RECONNECT_TIMEOUT_MS` (the same "how long do we wait for the panel to come back" bound, applied on the other side of the same event) — docs/design/self-update.md §4 on why this is deliberately one number, not two that could drift. */
export const HEALTH_POLL_TIMEOUT_MS = 90_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;

export interface UpdaterTarget {
  readonly serverContainerName: string;
  readonly brokerContainerName: string;
  /** Full `repo:version` reference — already composed (`image-refs.ts`), never assembled again here. */
  readonly serverImageRef: string;
  readonly brokerImageRef: string;
}

/**
 * The durable record `updater-entrypoint.ts` writes to
 * `/app/data/self-update-result.json` on the `server-data` volume
 * (docs/design/self-update.md §4, §6) — the one channel the outcome ever
 * reaches the new `dwg-server` process through, since nothing survives to
 * report it synchronously (§6's own reasoning: the process that would
 * report it is deliberately about to be replaced).
 *
 * Two phases of the *same* file, written in this order:
 *
 *  - `'in-progress'`, written once — right after both containers' specs
 *    are captured, before either is touched — carries the full rollback
 *    plan for both. This is docs/design/self-update.md §9.7's "write the
 *    rollback plan to the status file before any teardown": if the
 *    updater process itself crashes from this point on, this is what is
 *    left behind for a human to finish the job by hand (v1 has no
 *    automatic resume — §9.7).
 *  - `'done'`, written once, overwriting the above, once the sequence
 *    concludes one way or another. This is the shape the server's
 *    read-and-clear endpoint (SU-C) actually surfaces to an admin; it
 *    never reads or acts on an `'in-progress'` file, since that shape
 *    means the updater has not finished (or crashed) — treated as "no
 *    verdict yet" rather than a false success or failure.
 */
export type SelfUpdateResultFile =
  | {
      readonly phase: 'in-progress';
      readonly toVersion: string;
      readonly rollbackPlan: {
        readonly server: RawContainerRecreateSpec;
        readonly broker: RawContainerRecreateSpec;
      };
    }
  | {
      readonly phase: 'done';
      readonly outcome: 'success' | 'rolled-back' | 'failed';
      /** `null` when it could not be determined — e.g. a pull failed before anything was inspected, or the running image's tag does not match this project's version convention. Never a fabricated placeholder. */
      readonly fromVersion: string | null;
      readonly toVersion: string;
      readonly failedAt: 'pre-flight' | 'server-health' | 'broker-health' | null;
      readonly reason: string | null;
    };

export interface UpdaterDeps {
  readonly docker: DockerApi;
  readonly target: UpdaterTarget;
  /** Wall-clock read, injected exactly like `BackupUploaderDeps.now` — used only to bound the health-poll loop against {@link HEALTH_POLL_TIMEOUT_MS}. */
  readonly now: () => Date;
  /**
   * The health-poll loop's "wait" step, injected separately from `now` so
   * tests can make bounded-timeout behaviour deterministic without a real
   * 90-second wait: a test's `delay` both resolves immediately *and*
   * advances its own fake `now()` by the same amount, so the loop's real
   * bound-checking logic runs unmodified while no wall-clock time passes.
   * A real `setTimeout`-based delay is wired only from
   * `updater-entrypoint.ts` — never from a test.
   */
  readonly delay: (ms: number) => Promise<void>;
  /** Persists {@link SelfUpdateResultFile} — a real filesystem write in `updater-entrypoint.ts`, an in-memory capture in tests. See that type's own doc comment for when each phase is written and why. */
  readonly writeResultFile: (content: SelfUpdateResultFile) => Promise<void>;
}

export type UpdaterOutcome =
  | { readonly outcome: 'success' }
  | { readonly outcome: 'rolled-back'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly reason: string };

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort: resolves the human version for an already-captured spec's `image` (a digest) via `listImages()`'s repo-tag join — the same join `operations.ts`'s `handlePanelSelfUpdateCheck` uses. `null`, never fabricated, when no match is found. */
async function resolveFromVersion(docker: DockerApi, serverImage: string): Promise<string | null> {
  const images = await docker.listImages();
  const match = images.find((image) => image.id === serverImage);
  if (match === undefined) return null;
  return extractPanelVersion(match.repoTags, PANEL_SERVER_REPOSITORY);
}

async function resolveIdByName(docker: DockerApi, name: string): Promise<string | null> {
  const all = await docker.listContainers({ all: true });
  return all.find((container) => container.names.includes(name))?.id ?? null;
}

async function stopAndRemove(docker: DockerApi, id: string): Promise<void> {
  try {
    await docker.stopContainer(id);
  } catch {
    // Already stopped (or never started) is fine — removal is what matters.
  }
  await docker.removeContainer(id, { force: true });
}

async function createAndStart(docker: DockerApi, spec: RawContainerRecreateSpec): Promise<string> {
  const { id } = await docker.createContainer(spec);
  await docker.startContainer(id);
  return id;
}

async function waitForHealthy(deps: UpdaterDeps, containerId: string): Promise<boolean> {
  const deadline = deps.now().getTime() + HEALTH_POLL_TIMEOUT_MS;
  for (;;) {
    const inspection = await deps.docker.inspectContainer(containerId);
    if (inspection.state.health === 'healthy') return true;
    if (deps.now().getTime() >= deadline) return false;
    await deps.delay(HEALTH_POLL_INTERVAL_MS);
  }
}

/** Recreates one container from a captured spec with `image` swapped, and waits for it to report healthy. Returns the new container's id alongside the health verdict, since a failed recreate still needs its (unhealthy) new id to tear back down. */
async function recreateAndWaitHealthy(
  deps: UpdaterDeps,
  currentId: string,
  targetSpec: RawContainerRecreateSpec,
): Promise<{ readonly newId: string; readonly healthy: boolean }> {
  await stopAndRemove(deps.docker, currentId);
  const newId = await createAndStart(deps.docker, targetSpec);
  const healthy = await waitForHealthy(deps, newId);
  return { newId, healthy };
}

export async function runSelfUpdate(deps: UpdaterDeps): Promise<UpdaterOutcome> {
  const { docker, target } = deps;
  const toVersion = versionFromReference(target.serverImageRef);

  try {
    await docker.pullImage(target.serverImageRef);
    await docker.pullImage(target.brokerImageRef);
  } catch (err) {
    const reason = `Could not pull one or both target images: ${describeError(err)}`;
    await deps.writeResultFile({
      phase: 'done',
      outcome: 'failed',
      fromVersion: null,
      toVersion,
      failedAt: 'pre-flight',
      reason,
    });
    return { outcome: 'failed', reason };
  }

  const serverId = await resolveIdByName(docker, target.serverContainerName);
  const brokerId = await resolveIdByName(docker, target.brokerContainerName);
  if (serverId === null || brokerId === null) {
    const reason = "Could not find the panel's own containers by their configured names.";
    await deps.writeResultFile({
      phase: 'done',
      outcome: 'failed',
      fromVersion: null,
      toVersion,
      failedAt: 'pre-flight',
      reason,
    });
    return { outcome: 'failed', reason };
  }

  // Both rollback plans captured up front, before either container is
  // touched — see this file's header on why lazy capture would leave a
  // later step with no plan to roll back to.
  const serverPlan = await docker.inspectContainerForRecreate(serverId);
  const brokerPlan = await docker.inspectContainerForRecreate(brokerId);
  const fromVersion = await resolveFromVersion(docker, serverPlan.image);

  // Written before any teardown (docs/design/self-update.md §9.7) — a
  // crash from here on leaves this recovery data behind, not silence.
  await deps.writeResultFile({
    phase: 'in-progress',
    toVersion,
    rollbackPlan: { server: serverPlan, broker: brokerPlan },
  });

  const serverResult = await recreateAndWaitHealthy(deps, serverId, {
    ...serverPlan,
    image: target.serverImageRef,
  });
  if (!serverResult.healthy) {
    await stopAndRemove(docker, serverResult.newId);
    await createAndStart(docker, serverPlan);
    const reason = 'The recreated server container did not become healthy in time.';
    await deps.writeResultFile({
      phase: 'done',
      outcome: 'rolled-back',
      fromVersion,
      toVersion,
      failedAt: 'server-health',
      reason,
    });
    return { outcome: 'rolled-back', reason };
  }

  const brokerResult = await recreateAndWaitHealthy(deps, brokerId, {
    ...brokerPlan,
    image: target.brokerImageRef,
  });
  if (!brokerResult.healthy) {
    // Roll back BOTH — the server is already on the new version at this
    // point, and this project never leaves the two on different versions
    // (see this file's header).
    await stopAndRemove(docker, serverResult.newId);
    await createAndStart(docker, serverPlan);
    await stopAndRemove(docker, brokerResult.newId);
    await createAndStart(docker, brokerPlan);
    const reason = 'The recreated broker container did not become healthy in time.';
    await deps.writeResultFile({
      phase: 'done',
      outcome: 'rolled-back',
      fromVersion,
      toVersion,
      failedAt: 'broker-health',
      reason,
    });
    return { outcome: 'rolled-back', reason };
  }

  await deps.writeResultFile({
    phase: 'done',
    outcome: 'success',
    fromVersion,
    toVersion,
    failedAt: null,
    reason: null,
  });
  return { outcome: 'success' };
}
