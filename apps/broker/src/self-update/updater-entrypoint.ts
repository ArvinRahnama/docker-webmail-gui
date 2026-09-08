/**
 * The real, standalone process `operations.ts`'s `handlePanelSelfUpdateApply`
 * launches as a detached container (docs/design/self-update.md §1) — the
 * alternate command (`node apps/broker/dist/self-update/updater-entrypoint.js`
 * in place of `apps/broker/dist/index.js`) run inside a fresh container
 * of the broker's own current image, with the Docker socket bind-mounted
 * exactly like `dwg-broker` itself has it. This is what lets
 * {@link runSelfUpdate} recreate `dwg-broker` at all: by the time it does,
 * this process is running in a *different* container from the one being
 * replaced.
 *
 * Deliberately thin — every real decision lives in `updater.ts`'s
 * dependency-injected, directly-tested state machine. This file only:
 * reads the five environment variables `handlePanelSelfUpdateApply` set
 * at launch, builds one real `DockerApi` (`docker-client.ts` — the exact
 * same adapter `dwg-broker` itself runs on), calls
 * {@link runSelfUpdate}, and reports the outcome. Not exercised by any
 * test — there is no real Docker daemon in this environment, the same
 * "not exercised, but type-checks" boundary `docker-client.ts` documents
 * for itself.
 *
 * **Not yet built (SU-C):** writing the outcome to the durable status
 * file the new `dwg-server` reads (docs/design/self-update.md §4, §6).
 * Logging it to stdout in the meantime is not silence — both panel
 * containers already run under `docker/compose.yaml`'s `json-file`
 * logging driver, so the outcome is captured either way.
 */
import { createRealDockerApi } from '../docker-client.js';
import { runSelfUpdate, type UpdaterTarget } from './updater.js';

const DEFAULT_DOCKER_SOCKET_PATH = '/var/run/docker.sock';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`updater-entrypoint: missing required environment variable ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const target: UpdaterTarget = {
    serverContainerName: requiredEnv('DWG_SELF_UPDATE_SERVER_CONTAINER_NAME'),
    brokerContainerName: requiredEnv('DWG_SELF_UPDATE_BROKER_CONTAINER_NAME'),
    serverImageRef: requiredEnv('DWG_SELF_UPDATE_SERVER_IMAGE_REF'),
    brokerImageRef: requiredEnv('DWG_SELF_UPDATE_BROKER_IMAGE_REF'),
  };
  const docker = createRealDockerApi(process.env.DOCKER_SOCKET_PATH ?? DEFAULT_DOCKER_SOCKET_PATH);

  const outcome = await runSelfUpdate({
    docker,
    target,
    now: () => new Date(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  // No pino logger of its own — stdout is this project's own captured,
  // bounded log sink (docker/compose.yaml's json-file driver, on both
  // panel containers already) — matches index.ts's own "the one place a
  // plain console call is correct" precedent.
  console.log(JSON.stringify({ selfUpdateOutcome: outcome }));
  process.exitCode = outcome.outcome === 'success' ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('updater-entrypoint: fatal error', err);
  process.exitCode = 1;
});
