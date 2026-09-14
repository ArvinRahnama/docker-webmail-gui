import { describe, expect, it } from 'vitest';
import {
  runSelfUpdate,
  type SelfUpdateResultFile,
  type UpdaterDeps,
  type UpdaterTarget,
} from './updater.js';
import { FakeDockerApi, type FakeImageSeed } from './fake-docker-api.js';
import { PANEL_BROKER_REPOSITORY, PANEL_SERVER_REPOSITORY } from './image-refs.js';

const OLD_SERVER_IMAGE = `${PANEL_SERVER_REPOSITORY}:0.3.0`;
const NEW_SERVER_IMAGE = `${PANEL_SERVER_REPOSITORY}:0.4.0`;
const OLD_BROKER_IMAGE = `${PANEL_BROKER_REPOSITORY}:0.3.0`;
const NEW_BROKER_IMAGE = `${PANEL_BROKER_REPOSITORY}:0.4.0`;

const TARGET: UpdaterTarget = {
  serverContainerName: 'dwg-server',
  brokerContainerName: 'dwg-broker',
  serverImageRef: NEW_SERVER_IMAGE,
  brokerImageRef: NEW_BROKER_IMAGE,
};

/** A clock+delay pair where `delay` both resolves immediately and advances `now()` by the same amount — see `updater.ts`'s own doc comment on `UpdaterDeps.delay` for why this is the shape that makes the bounded health-poll loop's real logic exercisable with no real wait. */
function fakeClock(): Pick<UpdaterDeps, 'now' | 'delay'> {
  let current = 0;
  return {
    now: () => new Date(current),
    delay: async (ms: number) => {
      current += ms;
    },
  };
}

/** Captures every `SelfUpdateResultFile` write, in order — the in-memory stand-in for `updater-entrypoint.ts`'s real filesystem write, so tests can assert both *that* the rollback plan is written before any teardown (§9.7) and what the final admin-facing verdict says. */
function capturingResultFileWriter(): {
  writeResultFile: UpdaterDeps['writeResultFile'];
  writes: SelfUpdateResultFile[];
} {
  const writes: SelfUpdateResultFile[] = [];
  return {
    writeResultFile: async (content) => {
      writes.push(content);
    },
    writes,
  };
}

/**
 * Image-baked config modelled on the real `docker/server/Dockerfile` and
 * `docker/broker/Dockerfile` runtime stages (plus the `node` base image's
 * own `PATH`/`NODE_VERSION`/`YARN_VERSION`, and the release workflow's OCI
 * labels) — the values Docker merges into every container's inspected
 * config, and so the values the updater must not pin onto the next image.
 */
function serverImage(reference: string, version: string): FakeImageSeed {
  return {
    reference,
    env: [
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'NODE_VERSION=24.1.0',
      'YARN_VERSION=1.22.22',
      'NODE_ENV=production',
      `DWG_VERSION=${version}`,
      'DWG_IMAGE_ORIGIN=registry',
      'DATA_DIR=/app/data',
      'BACKUP_DIR=/app/backups',
      'STATIC_DIR=/app/apps/web/dist',
    ],
    labels: { 'org.opencontainers.image.version': version },
    cmd: ['node', 'apps/server/dist/index.js'],
  };
}

function brokerImage(reference: string, version: string): FakeImageSeed {
  return {
    reference,
    env: [
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'NODE_VERSION=24.1.0',
      'YARN_VERSION=1.22.22',
      'NODE_ENV=production',
      `DWG_VERSION=${version}`,
      'DWG_IMAGE_ORIGIN=registry',
    ],
    labels: { 'org.opencontainers.image.version': version },
    cmd: ['node', 'apps/broker/dist/index.js'],
  };
}

/** A subset of `docker/compose.yaml`'s own `environment:` for each service — genuine operator configuration, none of it defined by either image. */
const SERVER_OPERATOR_ENV = [
  'APP_MODE=production',
  'PORT=3000',
  'COOKIE_SECRET=cookie-secret',
  'BROKER_URL=http://broker:4000',
  'BROKER_SHARED_SECRET=shared-secret',
];
const BROKER_OPERATOR_ENV = [
  'BROKER_HOST=0.0.0.0',
  'BROKER_PORT=4000',
  'BROKER_SHARED_SECRET=shared-secret',
  'DOCKER_SOCKET_PATH=/var/run/docker.sock',
];
const SERVER_COMPOSE_LABELS = { 'com.docker.compose.service': 'server' };
const BROKER_COMPOSE_LABELS = { 'com.docker.compose.service': 'broker' };

const ALL_IMAGES: readonly FakeImageSeed[] = [
  serverImage(OLD_SERVER_IMAGE, '0.3.0'),
  serverImage(NEW_SERVER_IMAGE, '0.4.0'),
  brokerImage(OLD_BROKER_IMAGE, '0.3.0'),
  brokerImage(NEW_BROKER_IMAGE, '0.4.0'),
];

/** Both containers exactly as `docker compose up` creates them: operator env + compose labels as container config, everything else inherited from the image. */
function seededFake(images: readonly FakeImageSeed[] = ALL_IMAGES): FakeDockerApi {
  return new FakeDockerApi(
    [
      {
        id: 'server-old',
        name: 'dwg-server',
        image: OLD_SERVER_IMAGE,
        env: SERVER_OPERATOR_ENV,
        labels: SERVER_COMPOSE_LABELS,
      },
      {
        id: 'broker-old',
        name: 'dwg-broker',
        image: OLD_BROKER_IMAGE,
        env: BROKER_OPERATOR_ENV,
        labels: BROKER_COMPOSE_LABELS,
      },
    ],
    images,
  );
}

describe('runSelfUpdate — success', () => {
  it('pulls both images, recreates server then broker, and reports success', async () => {
    const docker = seededFake();
    const { writeResultFile, writes } = capturingResultFileWriter();
    const deps: UpdaterDeps = { docker, target: TARGET, ...fakeClock(), writeResultFile };

    const outcome = await runSelfUpdate(deps);

    expect(outcome).toEqual({ outcome: 'success' });
    expect(docker.calls).toEqual([
      `pullImage:${NEW_SERVER_IMAGE}`,
      `pullImage:${NEW_BROKER_IMAGE}`,
      'inspectContainerForRecreate:server-old',
      'inspectContainerForRecreate:broker-old',
      `inspectImageConfig:${OLD_SERVER_IMAGE}`,
      `inspectImageConfig:${OLD_BROKER_IMAGE}`,
      'stopContainer:server-old',
      'removeContainer:server-old',
      `createContainer:dwg-server:${NEW_SERVER_IMAGE}`,
      'startContainer:fake-container-1',
      'stopContainer:broker-old',
      'removeContainer:broker-old',
      `createContainer:dwg-broker:${NEW_BROKER_IMAGE}`,
      'startContainer:fake-container-2',
    ]);

    // Two writes: the in-progress rollback-plan record (before any
    // teardown), then the final success verdict.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ phase: 'in-progress', toVersion: '0.4.0' });
    expect(writes[1]).toEqual({
      phase: 'done',
      outcome: 'success',
      fromVersion: '0.3.0',
      toVersion: '0.4.0',
      failedAt: null,
      reason: null,
    });
  });
});

describe('runSelfUpdate — pull fails', () => {
  it('aborts before touching either container when a pull fails, and reports it honestly (no fromVersion yet resolved)', async () => {
    const docker = seededFake();
    docker.failPull(NEW_BROKER_IMAGE);
    const { writeResultFile, writes } = capturingResultFileWriter();
    const deps: UpdaterDeps = { docker, target: TARGET, ...fakeClock(), writeResultFile };

    const outcome = await runSelfUpdate(deps);

    expect(outcome).toEqual({
      outcome: 'failed',
      reason: expect.stringContaining('Could not pull'),
    });
    // Both pulls were attempted (server succeeded, broker failed) but
    // nothing beyond that — no inspect, no stop, no remove, no create.
    expect(docker.calls).toEqual([
      `pullImage:${NEW_SERVER_IMAGE}`,
      `pullImage:${NEW_BROKER_IMAGE}`,
    ]);
    // One write only — nothing was captured yet to write an in-progress
    // record for, so fromVersion is honestly null, never fabricated.
    expect(writes).toEqual([
      {
        phase: 'done',
        outcome: 'failed',
        fromVersion: null,
        toVersion: '0.4.0',
        failedAt: 'pre-flight',
        reason: expect.stringContaining('Could not pull'),
      },
    ]);
  });
});

describe('runSelfUpdate — server health fails', () => {
  it('rolls back the server only, from its captured spec, and never touches broker', async () => {
    const docker = seededFake();
    docker.setHealthy('dwg-server', NEW_SERVER_IMAGE, false);
    const { writeResultFile, writes } = capturingResultFileWriter();
    const deps: UpdaterDeps = { docker, target: TARGET, ...fakeClock(), writeResultFile };

    const outcome = await runSelfUpdate(deps);

    expect(outcome).toEqual({
      outcome: 'rolled-back',
      reason: expect.stringContaining('server container did not become healthy'),
    });
    expect(docker.calls).toEqual([
      `pullImage:${NEW_SERVER_IMAGE}`,
      `pullImage:${NEW_BROKER_IMAGE}`,
      'inspectContainerForRecreate:server-old',
      'inspectContainerForRecreate:broker-old',
      `inspectImageConfig:${OLD_SERVER_IMAGE}`,
      `inspectImageConfig:${OLD_BROKER_IMAGE}`,
      'stopContainer:server-old',
      'removeContainer:server-old',
      `createContainer:dwg-server:${NEW_SERVER_IMAGE}`,
      'startContainer:fake-container-1',
      // Roll back: tear down the unhealthy new one, recreate from the
      // captured OLD spec — not a re-derived one (the captured spec has
      // no other container to have been re-derived from at this point;
      // the image string on the rollback create call proves it is the
      // original, not the target).
      'stopContainer:fake-container-1',
      'removeContainer:fake-container-1',
      `createContainer:dwg-server:${OLD_SERVER_IMAGE}`,
      'startContainer:fake-container-2',
    ]);
    // Broker's spec was captured up front (per this file's header — both
    // rollback plans are captured before either container is touched),
    // but it is never stopped, removed or recreated.
    expect(
      docker.calls.some(
        (call) =>
          call.startsWith('stopContainer:broker') ||
          call.startsWith('removeContainer:broker') ||
          call.includes('createContainer:dwg-broker'),
      ),
    ).toBe(false);

    expect(writes[0]).toMatchObject({ phase: 'in-progress', toVersion: '0.4.0' });
    expect(writes[1]).toEqual({
      phase: 'done',
      outcome: 'rolled-back',
      fromVersion: '0.3.0',
      toVersion: '0.4.0',
      failedAt: 'server-health',
      reason: expect.stringContaining('server container did not become healthy'),
    });
  });
});

describe('runSelfUpdate — broker health fails', () => {
  it('rolls back BOTH containers, never leaving a new-server/old-broker pair', async () => {
    const docker = seededFake();
    docker.setHealthy('dwg-broker', NEW_BROKER_IMAGE, false);
    const { writeResultFile, writes } = capturingResultFileWriter();
    const deps: UpdaterDeps = { docker, target: TARGET, ...fakeClock(), writeResultFile };

    const outcome = await runSelfUpdate(deps);

    expect(outcome).toEqual({
      outcome: 'rolled-back',
      reason: expect.stringContaining('broker container did not become healthy'),
    });
    expect(docker.calls).toEqual([
      `pullImage:${NEW_SERVER_IMAGE}`,
      `pullImage:${NEW_BROKER_IMAGE}`,
      'inspectContainerForRecreate:server-old',
      'inspectContainerForRecreate:broker-old',
      `inspectImageConfig:${OLD_SERVER_IMAGE}`,
      `inspectImageConfig:${OLD_BROKER_IMAGE}`,
      // Server recreates successfully (healthy by default).
      'stopContainer:server-old',
      'removeContainer:server-old',
      `createContainer:dwg-server:${NEW_SERVER_IMAGE}`,
      'startContainer:fake-container-1',
      // Broker recreates but fails health.
      'stopContainer:broker-old',
      'removeContainer:broker-old',
      `createContainer:dwg-broker:${NEW_BROKER_IMAGE}`,
      'startContainer:fake-container-2',
      // Roll back BOTH — server first (even though it was healthy), then broker.
      'stopContainer:fake-container-1',
      'removeContainer:fake-container-1',
      `createContainer:dwg-server:${OLD_SERVER_IMAGE}`,
      'startContainer:fake-container-3',
      'stopContainer:fake-container-2',
      'removeContainer:fake-container-2',
      `createContainer:dwg-broker:${OLD_BROKER_IMAGE}`,
      'startContainer:fake-container-4',
    ]);

    expect(writes[1]).toEqual({
      phase: 'done',
      outcome: 'rolled-back',
      fromVersion: '0.3.0',
      toVersion: '0.4.0',
      failedAt: 'broker-health',
      reason: expect.stringContaining('broker container did not become healthy'),
    });
  });
});

describe('runSelfUpdate — the rollback plan is written before any teardown', () => {
  it('the in-progress write carries both captured specs, and happens before the first stop/remove call', async () => {
    const docker = seededFake();
    const stopIndexes: number[] = [];
    let writeIndex = -1;
    const writes: SelfUpdateResultFile[] = [];
    let callCountAtWrite = -1;

    const deps: UpdaterDeps = {
      docker,
      target: TARGET,
      ...fakeClock(),
      writeResultFile: async (content) => {
        writes.push(content);
        if (content.phase === 'in-progress') callCountAtWrite = docker.calls.length;
      },
    };

    await runSelfUpdate(deps);

    // At the moment the in-progress record was written, only the two
    // pulls, two container captures and two old-image inspects had
    // happened — no stop/remove/create yet.
    expect(callCountAtWrite).toBe(6);
    const inProgress = writes.find((w) => w.phase === 'in-progress');
    expect(inProgress).toMatchObject({
      phase: 'in-progress',
      rollbackPlan: {
        server: { name: 'dwg-server', image: OLD_SERVER_IMAGE },
        broker: { name: 'dwg-broker', image: OLD_BROKER_IMAGE },
      },
    });
    void stopIndexes;
    void writeIndex;
  });
});

describe('runSelfUpdate — health polling is bounded', () => {
  it('gives up and rolls back once the timeout elapses, never waiting forever', async () => {
    const docker = seededFake();
    docker.setHealthy('dwg-server', NEW_SERVER_IMAGE, false);
    const clock = fakeClock();
    const { writeResultFile } = capturingResultFileWriter();
    let delayCalls = 0;
    const deps: UpdaterDeps = {
      docker,
      target: TARGET,
      now: clock.now,
      delay: async (ms) => {
        delayCalls += 1;
        await clock.delay(ms);
      },
      writeResultFile,
    };

    const outcome = await runSelfUpdate(deps);

    expect(outcome.outcome).toBe('rolled-back');
    // 90s bound / 2s interval = 45 polls before giving up — bounded, not unbounded.
    expect(delayCalls).toBeGreaterThan(0);
    expect(delayCalls).toBeLessThanOrEqual(45);
  });
});

/**
 * The 1.0.0 -> 1.0.1 production bug: the updater recreated each
 * container with its *inspected* env — Docker's merge of image `ENV` and
 * container env — so the old image's `DWG_VERSION` became explicit
 * container env on the new image and `panel.selfUpdateCheck` kept
 * reporting the old version. `image-swap-spec.ts` has the full rule;
 * these tests pin it at the state-machine level, through the fake's
 * Docker-style merge.
 */
describe('runSelfUpdate — never pins the old image’s env onto the new one', () => {
  function successDeps(docker: FakeDockerApi): {
    deps: UpdaterDeps;
    writes: SelfUpdateResultFile[];
  } {
    const { writeResultFile, writes } = capturingResultFileWriter();
    return { deps: { docker, target: TARGET, ...fakeClock(), writeResultFile }, writes };
  }

  it('recreates each container with only its own (operator) env, labels and no pinned cmd — so the new container reports the new image’s version', async () => {
    const docker = seededFake();
    const { deps } = successDeps(docker);

    expect(await runSelfUpdate(deps)).toEqual({ outcome: 'success' });

    const [serverSpec, brokerSpec] = docker.createdSpecs;
    expect(serverSpec).toMatchObject({
      name: 'dwg-server',
      image: NEW_SERVER_IMAGE,
      env: SERVER_OPERATOR_ENV,
      labels: SERVER_COMPOSE_LABELS,
      cmd: null,
    });
    expect(brokerSpec).toMatchObject({
      name: 'dwg-broker',
      image: NEW_BROKER_IMAGE,
      env: BROKER_OPERATOR_ENV,
      labels: BROKER_COMPOSE_LABELS,
      cmd: null,
    });

    // What `docker inspect` of the new containers now says — the exact
    // thing the pre-fix updater got wrong.
    const newServer = await docker.inspectContainerForRecreate('fake-container-1');
    expect(newServer.env).toContain('DWG_VERSION=0.4.0');
    expect(newServer.env).not.toContain('DWG_VERSION=0.3.0');
    expect(newServer.labels['org.opencontainers.image.version']).toBe('0.4.0');
    expect(newServer.cmd).toEqual(['node', 'apps/server/dist/index.js']);
    const newBroker = await docker.inspectContainerForRecreate('fake-container-2');
    expect(newBroker.env).toContain('DWG_VERSION=0.4.0');
    expect(newBroker.env).not.toContain('DWG_VERSION=0.3.0');
  });

  it('heals a container an earlier (pre-fix) updater already polluted: stale DWG_* and base-image markers are dropped, a real operator override of an image key is kept', async () => {
    // What production looks like after the buggy 1.0.0 -> 1.0.1 update:
    // the container runs the 0.3.0 image but carries the *0.2.0* image's
    // merged env as its own explicit env — stale DWG_VERSION, an older
    // base image's NODE_VERSION — plus a genuine operator override of an
    // image-defined key (NODE_ENV) and a value identical to its image.
    const pollutedServerEnv = [
      ...SERVER_OPERATOR_ENV,
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'NODE_VERSION=24.0.0',
      'YARN_VERSION=1.22.19',
      'NODE_ENV=development',
      'DWG_VERSION=0.2.0',
      'DWG_IMAGE_ORIGIN=registry',
      'DATA_DIR=/app/data',
      'BACKUP_DIR=/app/backups',
      'STATIC_DIR=/app/apps/web/dist',
    ];
    const docker = new FakeDockerApi(
      [
        {
          id: 'server-old',
          name: 'dwg-server',
          image: OLD_SERVER_IMAGE,
          env: pollutedServerEnv,
          labels: { ...SERVER_COMPOSE_LABELS, 'org.opencontainers.image.version': '0.2.0' },
        },
        { id: 'broker-old', name: 'dwg-broker', image: OLD_BROKER_IMAGE, env: BROKER_OPERATOR_ENV },
      ],
      ALL_IMAGES,
    );
    const { deps } = successDeps(docker);

    expect(await runSelfUpdate(deps)).toEqual({ outcome: 'success' });

    expect(docker.createdSpecs[0]?.env).toEqual([...SERVER_OPERATOR_ENV, 'NODE_ENV=development']);
    expect(docker.createdSpecs[0]?.labels).toEqual(SERVER_COMPOSE_LABELS);
    const healed = await docker.inspectContainerForRecreate('fake-container-1');
    expect(healed.env).toContain('DWG_VERSION=0.4.0');
    expect(healed.env).toContain('NODE_ENV=development');
    expect(healed.env).not.toContain('DWG_VERSION=0.2.0');
    expect(healed.env).not.toContain('NODE_VERSION=24.0.0');
  });

  it('when the old image cannot be inspected, still drops the image-provenance keys (the stale-version fix), keeps everything else, and does not abort', async () => {
    // Only the *target* images exist in the fake's registry, so inspecting
    // either old image rejects. The container is polluted the way
    // production is, so without an image to compare against the
    // unconditional provenance drop is the only thing standing between it
    // and a stale DWG_VERSION.
    const docker = new FakeDockerApi(
      [
        {
          id: 'server-old',
          name: 'dwg-server',
          image: OLD_SERVER_IMAGE,
          env: [...SERVER_OPERATOR_ENV, 'NODE_ENV=production', 'DWG_VERSION=0.2.0'],
        },
        { id: 'broker-old', name: 'dwg-broker', image: OLD_BROKER_IMAGE, env: BROKER_OPERATOR_ENV },
      ],
      [serverImage(NEW_SERVER_IMAGE, '0.4.0'), brokerImage(NEW_BROKER_IMAGE, '0.4.0')],
    );

    expect(await runSelfUpdate(successDeps(docker).deps)).toEqual({ outcome: 'success' });

    // NODE_ENV cannot be proven inherited without the image, so it is kept.
    expect(docker.createdSpecs[0]?.env).toEqual([...SERVER_OPERATOR_ENV, 'NODE_ENV=production']);
    const created = await docker.inspectContainerForRecreate('fake-container-1');
    expect(created.env).toContain('DWG_VERSION=0.4.0');
    expect(created.env).not.toContain('DWG_VERSION=0.2.0');
  });

  it('rolls back from the ORIGINAL captured spec — full merged env, labels and cmd — never the filtered one', async () => {
    const docker = seededFake();
    docker.setHealthy('dwg-broker', NEW_BROKER_IMAGE, false);
    const { deps, writes } = successDeps(docker);

    expect((await runSelfUpdate(deps)).outcome).toBe('rolled-back');

    const inProgress = writes.find((w) => w.phase === 'in-progress');
    if (inProgress?.phase !== 'in-progress') throw new Error('no in-progress record written');
    const { server: serverPlan, broker: brokerPlan } = inProgress.rollbackPlan;
    // The captured plan is the full, unfiltered inspect — DWG_VERSION and all.
    expect(serverPlan.env).toContain('DWG_VERSION=0.3.0');
    expect(serverPlan.env).toEqual(expect.arrayContaining(SERVER_OPERATOR_ENV));

    // createdSpecs: [new server, new broker, rollback server, rollback broker]
    expect(docker.createdSpecs).toHaveLength(4);
    expect(docker.createdSpecs[0]?.env).not.toContain('DWG_VERSION=0.3.0');
    expect(docker.createdSpecs[2]).toEqual(serverPlan);
    expect(docker.createdSpecs[3]).toEqual(brokerPlan);
  });
});
