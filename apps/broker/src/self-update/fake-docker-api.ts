/**
 * A stateful, call-logging `DockerApi` test double purpose-built for
 * `updater.test.ts` — not a general-purpose fake broker driver (this
 * project has no such thing; every other broker test builds its own
 * lightweight per-file stub, `operations.test.ts`'s `stubDocker`). The
 * updater's state machine drives a genuine multi-step choreography
 * (pull -> inspect -> stop/remove -> create/start -> poll -> maybe
 * roll back) where later calls must see the effects of earlier ones —
 * an ad-hoc `vi.fn()` stub per method cannot express that, which is
 * exactly why this exists as its own small, real in-memory model
 * instead.
 *
 * Every method not needed by the updater (`ping`, `statsContainer`,
 * `execContainer`, …) throws — this fake proves it is never called down
 * an unexpected path rather than silently returning a placeholder.
 */
import type { DockerApi, RawContainerListItem, RawContainerRecreateSpec } from '../docker-types.js';

export interface FakeContainerSeed {
  readonly id: string;
  readonly name: string;
  /** The image reference this container was "created" with — a container recreated with a different image is a genuinely different fake container, healthy/unhealthy independently (see `setHealthy`). */
  readonly image: string;
}

function notUsedByThisFake(method: string): never {
  throw new Error(`FakeDockerApi (self-update): ${method} is not used by the updater`);
}

export class FakeDockerApi implements DockerApi {
  /** Every mutating call, in order, as `"method:arg1:arg2"` — the exact sequence branch tests assert against. */
  readonly calls: string[] = [];

  private readonly containers = new Map<
    string,
    { name: string; image: string; running: boolean }
  >();
  /** `${name}:${image}` -> whether a container created with that exact name+image reports healthy. Defaults to healthy when unset, so a test only ever states the *unhealthy* case explicitly. */
  private readonly healthByKey = new Map<string, boolean>();
  private readonly failingPulls = new Set<string>();
  private nextId = 1;

  constructor(seed: readonly FakeContainerSeed[]) {
    for (const container of seed) {
      this.containers.set(container.id, {
        name: container.name,
        image: container.image,
        running: true,
      });
    }
  }

  /** Makes any future `createContainer` for this exact name+image report unhealthy — the lever branch tests use to force a rollback. */
  setHealthy(name: string, image: string, healthy: boolean): void {
    this.healthByKey.set(`${name}:${image}`, healthy);
  }

  /** Makes `pullImage(reference)` reject — the lever the pull-fail-abort test uses. */
  failPull(reference: string): void {
    this.failingPulls.add(reference);
  }

  private mustGet(id: string): { name: string; image: string; running: boolean } {
    const container = this.containers.get(id);
    if (container === undefined) throw new Error(`FakeDockerApi: no container with id ${id}`);
    return container;
  }

  async pullImage(reference: string): Promise<void> {
    this.calls.push(`pullImage:${reference}`);
    if (this.failingPulls.has(reference)) {
      throw new Error(`FakeDockerApi: pull of ${reference} was configured to fail`);
    }
  }

  async listContainers(): Promise<readonly RawContainerListItem[]> {
    return [...this.containers.entries()].map(([id, container]) => ({
      id,
      names: [container.name],
      image: container.image,
      state: container.running ? 'running' : 'exited',
      status: container.running ? 'Up' : 'Exited',
      labels: {},
      createdAt: 0,
      mountVolumeNames: [],
      networkNames: [],
    }));
  }

  async inspectContainer(id: string) {
    const container = this.mustGet(id);
    const healthy = this.healthByKey.get(`${container.name}:${container.image}`) ?? true;
    return {
      id,
      name: container.name,
      image: container.image,
      createdAt: new Date(0).toISOString(),
      tty: false,
      restartCount: 0,
      labels: {},
      state: {
        status: container.running ? 'running' : 'exited',
        running: container.running,
        paused: false,
        restarting: false,
        startedAt: new Date(0).toISOString(),
        finishedAt: '',
        exitCode: 0,
        health: healthy ? 'healthy' : 'unhealthy',
      },
      mounts: [],
    };
  }

  async inspectContainerForRecreate(id: string): Promise<RawContainerRecreateSpec> {
    this.calls.push(`inspectContainerForRecreate:${id}`);
    const container = this.mustGet(id);
    return {
      name: container.name,
      image: container.image,
      env: [],
      labels: {},
      cmd: null,
      hostConfig: {},
      networkingConfig: {},
    };
  }

  async createContainer(spec: RawContainerRecreateSpec): Promise<{ readonly id: string }> {
    const id = `fake-container-${this.nextId}`;
    this.nextId += 1;
    this.calls.push(`createContainer:${spec.name}:${spec.image}`);
    this.containers.set(id, { name: spec.name, image: spec.image, running: false });
    return { id };
  }

  async startContainer(id: string): Promise<void> {
    this.calls.push(`startContainer:${id}`);
    this.mustGet(id).running = true;
  }

  async stopContainer(id: string): Promise<void> {
    this.calls.push(`stopContainer:${id}`);
    this.mustGet(id).running = false;
  }

  async removeContainer(id: string): Promise<void> {
    this.calls.push(`removeContainer:${id}`);
    this.containers.delete(id);
  }

  // Everything below is genuinely unused by the updater state machine.
  ping = (): Promise<void> => notUsedByThisFake('ping');
  version = (): ReturnType<DockerApi['version']> => notUsedByThisFake('version');
  info = (): ReturnType<DockerApi['info']> => notUsedByThisFake('info');
  df = (): ReturnType<DockerApi['df']> => notUsedByThisFake('df');
  restartContainer = (): Promise<void> => notUsedByThisFake('restartContainer');
  statsContainer = (): ReturnType<DockerApi['statsContainer']> =>
    notUsedByThisFake('statsContainer');
  logsContainer = (): ReturnType<DockerApi['logsContainer']> => notUsedByThisFake('logsContainer');
  listImages = (): ReturnType<DockerApi['listImages']> => notUsedByThisFake('listImages');
  listVolumes = (): ReturnType<DockerApi['listVolumes']> => notUsedByThisFake('listVolumes');
  listNetworks = (): ReturnType<DockerApi['listNetworks']> => notUsedByThisFake('listNetworks');
  removeVolume = (): Promise<void> => notUsedByThisFake('removeVolume');
  pruneImages = (): ReturnType<DockerApi['pruneImages']> => notUsedByThisFake('pruneImages');
  execContainer = (): ReturnType<DockerApi['execContainer']> => notUsedByThisFake('execContainer');
  getContainerArchive = (): ReturnType<DockerApi['getContainerArchive']> =>
    notUsedByThisFake('getContainerArchive');
  putContainerArchive = (): Promise<void> => notUsedByThisFake('putContainerArchive');
}
