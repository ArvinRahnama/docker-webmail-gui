import { describe, expect, it } from 'vitest';
import {
  runSelfUpdate,
  type SelfUpdateResultFile,
  type UpdaterDeps,
  type UpdaterTarget,
} from './updater.js';
import { FakeDockerApi } from './fake-docker-api.js';
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

function seededFake(): FakeDockerApi {
  return new FakeDockerApi([
    { id: 'server-old', name: 'dwg-server', image: OLD_SERVER_IMAGE },
    { id: 'broker-old', name: 'dwg-broker', image: OLD_BROKER_IMAGE },
  ]);
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
    // pulls and two captures had happened — no stop/remove/create yet.
    expect(callCountAtWrite).toBe(4);
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
