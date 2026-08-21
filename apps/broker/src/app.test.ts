import { describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  BROKER_OPS_PATH,
  BROKER_SECRET_HEADER,
  ConsoleExecResponseSchema,
  ContainerInspectResponseSchema,
  ContainerListResponseSchema,
  ContainerLogsResponseSchema,
  ContainerStatsResponseSchema,
  ImageListResponseSchema,
  ImagePruneResponseSchema,
  LogsFileResponseSchema,
  NetworkListResponseSchema,
  OperationAckSchema,
  SystemDfResponseSchema,
  SystemInfoResponseSchema,
  SystemPingResponseSchema,
  SystemVersionResponseSchema,
  VolumeListResponseSchema,
} from '@dwg/shared';
import { buildBrokerApp } from './app.js';
import type { BrokerConfig } from './config.js';
import type {
  DockerApi,
  RawContainerInspect,
  RawContainerListItem,
  RawContainerMount,
  RawContainerStats,
  RawImage,
  RawNetwork,
  RawSystemDf,
  RawSystemInfo,
  RawVersion,
  RawVolume,
} from './docker-types.js';

const SECRET = 'a'.repeat(32);

function testLogger() {
  return pino({ level: 'silent' });
}

function testConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return {
    port: 4000,
    host: '0.0.0.0',
    logLevel: 'info',
    sharedSecret: SECRET,
    dockerSocketPath: '/var/run/docker.sock',
    dms: { containerName: 'mailserver', containerLabel: null },
    ...overrides,
  };
}

const MAILSERVER_CONTAINER: RawContainerListItem = {
  id: 'mailserver-id',
  names: ['mailserver'],
  image: 'ghcr.io/docker-mailserver/docker-mailserver:latest',
  state: 'running',
  status: 'Up 2 hours',
  labels: {},
  createdAt: 1_700_000_000,
};

/**
 * One protected DMS data mount (`/var/mail`, backing `dms-mail-data`) and
 * one ordinary mount (`dms-scratch`) — mirrors
 * `apps/server/src/drivers/broker/fixtures/containers.ts`'s
 * `FIXTURE_CONTAINER_MOUNTS` shape so the `volume.remove` tests below
 * exercise both the refused and the permitted path.
 */
const MAILSERVER_MOUNTS: readonly RawContainerMount[] = [
  { type: 'volume', name: 'dms-mail-data', destination: '/var/mail' },
  { type: 'volume', name: 'dms-scratch', destination: '/scratch' },
];

const MAILSERVER_INSPECT: RawContainerInspect = {
  id: 'mailserver-id',
  name: 'mailserver',
  image: 'ghcr.io/docker-mailserver/docker-mailserver:latest',
  createdAt: '2026-08-01T00:00:00.000Z',
  tty: false,
  restartCount: 0,
  labels: {},
  state: {
    status: 'running',
    running: true,
    paused: false,
    restarting: false,
    startedAt: '2026-08-15T00:00:00.000Z',
    finishedAt: '0001-01-01T00:00:00Z',
    exitCode: 0,
    health: 'healthy',
  },
  mounts: MAILSERVER_MOUNTS,
};

const RAW_STATS: RawContainerStats = {
  cpu_stats: {
    cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2] },
    system_cpu_usage: 10_000_000_000,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1_000_000_000, percpu_usage: [1, 2] },
    system_cpu_usage: 8_000_000_000,
  },
  memory_stats: { usage: 100_000_000, limit: 500_000_000, stats: { cache: 10_000_000 } },
  pids_stats: { current: 5 },
  networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
};

const RAW_VERSION: RawVersion = {
  version: '29.7.0',
  apiVersion: '1.55',
  minApiVersion: '1.24',
  os: 'linux',
  arch: 'amd64',
  kernelVersion: '6.8.0-generic',
};
const RAW_INFO: RawSystemInfo = {
  containers: 1,
  containersRunning: 1,
  containersPaused: 0,
  containersStopped: 0,
  images: 3,
  serverVersion: '29.7.0',
  driver: 'overlay2',
  ncpu: 4,
  memTotal: 8_000_000_000,
};
const RAW_DF: RawSystemDf = {
  layersSizeBytes: 100,
  imagesCount: 3,
  containersCount: 1,
  volumesCount: 2,
  buildCacheBytes: 0,
};
const RAW_IMAGE: RawImage = {
  id: 'img1',
  repoTags: ['alpine:latest'],
  sizeBytes: 1000,
  createdAt: 1_700_000_000,
  labels: {},
};
const RAW_VOLUME: RawVolume = {
  name: 'vol1',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/vol1/_data',
  labels: {},
};
const RAW_NETWORK: RawNetwork = { id: 'net1', name: 'bridge', driver: 'bridge', scope: 'local' };

/** Builds one raw multiplexed log frame per docs/research/02-docker-api-security.md §A.2. */
function buildLogFrame(streamType: number, payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
const LOG_BUFFER = Buffer.concat([
  buildLogFrame(1, 'log line one'),
  buildLogFrame(2, 'log line two'),
]);

function createStubDocker(overrides: Partial<DockerApi> = {}): DockerApi {
  return {
    ping: async () => {},
    version: async () => RAW_VERSION,
    info: async () => RAW_INFO,
    df: async () => RAW_DF,
    listContainers: async () => [MAILSERVER_CONTAINER],
    inspectContainer: async () => MAILSERVER_INSPECT,
    startContainer: async () => {},
    stopContainer: async () => {},
    restartContainer: async () => {},
    statsContainer: async () => RAW_STATS,
    logsContainer: async () => LOG_BUFFER,
    listImages: async () => [RAW_IMAGE],
    listVolumes: async () => [RAW_VOLUME],
    listNetworks: async () => [RAW_NETWORK],
    removeVolume: async () => {},
    pruneImages: async () => ({ imagesDeleted: ['sha256:pruned'], spaceReclaimedBytes: 1000 }),
    execContainer: async () => ({ stdout: 'stub output\n', stderr: '', exitCode: 0 }),
    getContainerArchive: () => Promise.reject(new Error('not stubbed')),
    putContainerArchive: () => Promise.reject(new Error('not stubbed')),
    ...overrides,
  };
}

function buildTestApp(
  dockerOverrides: Partial<DockerApi> = {},
  configOverrides: Partial<BrokerConfig> = {},
) {
  return buildBrokerApp({
    config: testConfig(configOverrides),
    logger: testLogger(),
    docker: createStubDocker(dockerOverrides),
  });
}

async function post(
  app: ReturnType<typeof buildTestApp>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { [BROKER_SECRET_HEADER]: SECRET },
) {
  return app.inject({ method: 'POST', url: BROKER_OPS_PATH, headers, payload });
}

// ---------------------------------------------------------------------------
// Acceptance criteria: shared-secret authentication
// ---------------------------------------------------------------------------

describe('shared-secret authentication', () => {
  it('rejects a request with no secret header', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'system.ping' }, {});
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    await app.close();
  });

  it('rejects a request with the wrong secret', async () => {
    const app = buildTestApp();
    const response = await post(
      app,
      { operation: 'system.ping' },
      {
        [BROKER_SECRET_HEADER]: 'b'.repeat(32),
      },
    );
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an empty secret header the same as a missing one', async () => {
    const app = buildTestApp();
    const response = await post(
      app,
      { operation: 'system.ping' },
      {
        [BROKER_SECRET_HEADER]: '',
      },
    );
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects before parsing: an unauthenticated request with an invalid JSON body still gets 401, not a parse-error response', async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: BROKER_OPS_PATH,
      headers: { 'content-type': 'application/json' },
      payload: '{this is not valid json',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    await app.close();
  });

  it('accepts a request with the correct secret', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'system.ping' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria: closed operation vocabulary
// ---------------------------------------------------------------------------

describe('operation validation', () => {
  it('rejects an unknown operation name', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'container.create', Image: 'alpine' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  it('rejects exec, which was never part of the vocabulary', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'exec.run', Cmd: ['postqueue', '-p'] });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a well-formed operation carrying an unexpected extra field', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'system.ping', extra: 'field' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  it('rejects a request body that is not an object at all', async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: BROKER_OPS_PATH,
      headers: { [BROKER_SECRET_HEADER]: SECRET, 'content-type': 'application/json' },
      payload: JSON.stringify('just a string'),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria: the container allowlist
// ---------------------------------------------------------------------------

describe('container allowlist', () => {
  it('refuses a lifecycle operation when no container matches the configured identity', async () => {
    const app = buildTestApp({
      listContainers: async () => [{ ...MAILSERVER_CONTAINER, names: ['not-mailserver'] }],
    });
    const response = await post(app, { operation: 'container.start' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    await app.close();
  });

  it('refuses when the container list is empty', async () => {
    const app = buildTestApp({ listContainers: async () => [] });
    const response = await post(app, { operation: 'container.stop' });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('refuses container.inspect, container.stats and container.logs the same way lifecycle ops are refused', async () => {
    const app = buildTestApp({ listContainers: async () => [] });
    for (const operation of ['container.inspect', 'container.stats', 'container.logs']) {
      const response = await post(app, { operation });
      expect(response.statusCode, operation).toBe(403);
      expect(response.json().error.code, operation).toBe('FORBIDDEN');
    }
    await app.close();
  });

  it('does not gate container.list on allowlist resolution — it addresses containers plural, and stays read-only', async () => {
    const app = buildTestApp({ listContainers: async () => [] });
    const response = await post(app, { operation: 'container.list' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ containers: [] });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Successful operations — every response conforms to its shared schema
// ---------------------------------------------------------------------------

describe('successful operations', () => {
  it('container.list', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'container.list' });
    expect(response.statusCode).toBe(200);
    expect(ContainerListResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('container.list passes the "all" param through to the Docker adapter', async () => {
    let receivedAll: boolean | undefined;
    const app = buildTestApp({
      listContainers: async (options) => {
        receivedAll = options.all;
        return [MAILSERVER_CONTAINER];
      },
    });
    await post(app, { operation: 'container.list', all: true });
    expect(receivedAll).toBe(true);
    await app.close();
  });

  it('container.inspect', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'container.inspect' });
    expect(response.statusCode).toBe(200);
    expect(ContainerInspectResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('container.start acknowledges and calls the adapter with the resolved id', async () => {
    let calledWith: string | undefined;
    const app = buildTestApp({
      startContainer: async (id) => {
        calledWith = id;
      },
    });
    const response = await post(app, { operation: 'container.start' });
    expect(response.statusCode).toBe(200);
    expect(OperationAckSchema.safeParse(response.json()).success).toBe(true);
    expect(calledWith).toBe(MAILSERVER_CONTAINER.id);
    await app.close();
  });

  it('container.stop', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'container.stop' });
    expect(OperationAckSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('container.restart', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'container.restart' });
    expect(OperationAckSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('container.stats returns computed percentages, not raw Docker counters', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'container.stats' });
    const result = ContainerStatsResponseSchema.safeParse(response.json());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cpuPercent).toBeGreaterThan(0);
      expect(result.data.memory.percent).toBeGreaterThan(0);
      // Raw Docker field names must never leak into the response shape.
      expect(response.json()).not.toHaveProperty('cpu_stats');
    }
    await app.close();
  });

  it('container.logs decodes the non-TTY multiplexed buffer into structured lines', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'container.logs' });
    const result = ContainerLogsResponseSchema.safeParse(response.json());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines).toEqual([
        { stream: 'stdout', data: 'log line one' },
        { stream: 'stderr', data: 'log line two' },
      ]);
    }
    await app.close();
  });

  it('container.logs decodes raw TTY bytes when the resolved container has a TTY', async () => {
    const app = buildTestApp({
      inspectContainer: async () => ({ ...MAILSERVER_INSPECT, tty: true }),
      logsContainer: async () => Buffer.from('raw tty output, no framing'),
    });
    const response = await post(app, { operation: 'container.logs' });
    const result = ContainerLogsResponseSchema.safeParse(response.json());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines).toEqual([{ stream: 'stdout', data: 'raw tty output, no framing' }]);
    }
    await app.close();
  });

  it('system.ping', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'system.ping' });
    expect(SystemPingResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('system.version', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'system.version' });
    expect(SystemVersionResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('system.info', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'system.info' });
    expect(SystemInfoResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('system.df', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'system.df' });
    expect(SystemDfResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('image.list', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'image.list' });
    expect(ImageListResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('volume.list', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'volume.list' });
    expect(VolumeListResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('network.list', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'network.list' });
    expect(NetworkListResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// M9 additions
// ---------------------------------------------------------------------------

describe('volume.remove', () => {
  it('removes an ordinary volume and calls the adapter with its name', async () => {
    let calledWith: string | undefined;
    const app = buildTestApp({
      removeVolume: async (name) => {
        calledWith = name;
      },
    });
    const response = await post(app, { operation: 'volume.remove', name: 'dms-scratch' });
    expect(response.statusCode).toBe(200);
    expect(OperationAckSchema.safeParse(response.json()).success).toBe(true);
    expect(calledWith).toBe('dms-scratch');
    await app.close();
  });

  it('refuses to remove a volume backing a protected DMS data mount, without ever calling the adapter', async () => {
    let removeCalled = false;
    const app = buildTestApp({
      removeVolume: async () => {
        removeCalled = true;
      },
    });
    const response = await post(app, { operation: 'volume.remove', name: 'dms-mail-data' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(removeCalled).toBe(false);
    await app.close();
  });

  it('re-derives the protected set from the managed container every call, not a hardcoded name', async () => {
    // Same volume name, but this time it backs no protected destination —
    // proves the refusal above is driven by the live mounts, not a
    // literal "dms-mail-data" string comparison baked into the broker.
    let calledWith: string | undefined;
    const app = buildTestApp({
      inspectContainer: async () => ({
        ...MAILSERVER_INSPECT,
        mounts: [{ type: 'volume', name: 'dms-mail-data', destination: '/scratch-only' }],
      }),
      removeVolume: async (name) => {
        calledWith = name;
      },
    });
    const response = await post(app, { operation: 'volume.remove', name: 'dms-mail-data' });
    expect(response.statusCode).toBe(200);
    expect(calledWith).toBe('dms-mail-data');
    await app.close();
  });
});

describe('image.prune', () => {
  it('takes no parameters and reports what the adapter deleted', async () => {
    const app = buildTestApp();
    const response = await post(app, { operation: 'image.prune' });
    expect(response.statusCode).toBe(200);
    const result = ImagePruneResponseSchema.safeParse(response.json());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imagesDeleted).toEqual(['sha256:pruned']);
    }
    await app.close();
  });

  it('rejects an attempt to target a specific image — there is no such field', async () => {
    const response = await post(buildTestApp(), {
      operation: 'image.prune',
      imageId: 'sha256:pruned',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('logs.file', () => {
  it('reads the mail source via a broker-owned tail invocation, never a client path', async () => {
    let receivedArgv: readonly string[] | undefined;
    const app = buildTestApp({
      execContainer: async (_id, argv) => {
        receivedArgv = argv;
        return { stdout: 'line one\nline two\n', stderr: '', exitCode: 0 };
      },
    });
    const response = await post(app, { operation: 'logs.file', source: 'mail' });
    expect(response.statusCode).toBe(200);
    const result = LogsFileResponseSchema.safeParse(response.json());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines).toEqual(['line one', 'line two']);
    }
    expect(receivedArgv).toEqual(['tail', '-n', '200', '/var/log/mail/mail.log']);
    await app.close();
  });

  it('reads the fail2ban source from its own distinct hardcoded path', async () => {
    let receivedArgv: readonly string[] | undefined;
    const app = buildTestApp({
      execContainer: async (_id, argv) => {
        receivedArgv = argv;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await post(app, { operation: 'logs.file', source: 'fail2ban' });
    expect(receivedArgv).toEqual(['tail', '-n', '200', '/var/log/mail/fail2ban.log']);
    await app.close();
  });

  it('rejects a source outside the fixed enum, including a path-traversal attempt', async () => {
    for (const source of ['../../etc/passwd', '/etc/shadow', 'mail.log', '']) {
      const response = await post(buildTestApp(), { operation: 'logs.file', source });
      expect(response.statusCode, source).toBe(400);
      expect(response.json().error.code, source).toBe('VALIDATION_FAILED');
    }
  });
});

describe('console.exec', () => {
  it('runs an allowlisted command and echoes back the exact argv used', async () => {
    const app = buildTestApp({
      execContainer: async () => ({ stdout: 'Mail queue is empty\n', stderr: '', exitCode: 0 }),
    });
    const response = await post(app, { operation: 'console.exec', command: 'postqueue-p' });
    expect(response.statusCode).toBe(200);
    const result = ConsoleExecResponseSchema.safeParse(response.json());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.argv).toEqual(['postqueue', '-p']);
      expect(result.data.exitCode).toBe(0);
    }
    await app.close();
  });

  it('rejects a command outside the fixed enum', async () => {
    const response = await post(buildTestApp(), { operation: 'console.exec', command: 'rm-rf' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an attempt to pass a raw argv array instead of a symbolic command key', async () => {
    const response = await post(buildTestApp(), {
      operation: 'console.exec',
      command: 'postqueue-p',
      argv: ['rm', '-rf', '/'],
    });
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Docker call failures never leak raw error detail
// ---------------------------------------------------------------------------

describe('Docker call failures', () => {
  it('maps a Docker adapter failure to UPSTREAM_UNAVAILABLE without leaking the raw error', async () => {
    const app = buildTestApp({
      listImages: async () => {
        throw new Error('connect ECONNREFUSED /var/run/docker.sock');
      },
    });
    const response = await post(app, { operation: 'image.list' });
    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Unmatched routes
// ---------------------------------------------------------------------------

describe('unmatched routes', () => {
  it('returns the broker error envelope, not a bare Fastify 404 body', async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
