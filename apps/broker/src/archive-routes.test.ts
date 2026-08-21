import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { BROKER_SECRET_HEADER } from '@dwg/shared';
import { buildBrokerApp } from './app.js';
import type { BrokerConfig } from './config.js';
import type { DockerApi, RawContainerListItem } from './docker-types.js';

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
  status: 'Up 1 hour',
  labels: {},
  createdAt: 1_700_000_000,
};

function stubDocker(overrides: Partial<DockerApi> = {}): DockerApi {
  return {
    ping: () => Promise.reject(new Error('not stubbed')),
    version: () => Promise.reject(new Error('not stubbed')),
    info: () => Promise.reject(new Error('not stubbed')),
    df: () => Promise.reject(new Error('not stubbed')),
    listContainers: async () => [MAILSERVER_CONTAINER],
    inspectContainer: () => Promise.reject(new Error('not stubbed')),
    startContainer: () => Promise.reject(new Error('not stubbed')),
    stopContainer: () => Promise.reject(new Error('not stubbed')),
    restartContainer: () => Promise.reject(new Error('not stubbed')),
    statsContainer: () => Promise.reject(new Error('not stubbed')),
    logsContainer: () => Promise.reject(new Error('not stubbed')),
    listImages: () => Promise.reject(new Error('not stubbed')),
    listVolumes: () => Promise.reject(new Error('not stubbed')),
    listNetworks: () => Promise.reject(new Error('not stubbed')),
    removeVolume: () => Promise.reject(new Error('not stubbed')),
    pruneImages: () => Promise.reject(new Error('not stubbed')),
    execContainer: () => Promise.reject(new Error('not stubbed')),
    getContainerArchive: () => Promise.reject(new Error('not stubbed')),
    putContainerArchive: () => Promise.reject(new Error('not stubbed')),
    ...overrides,
  };
}

function buildTestApp(dockerOverrides: Partial<DockerApi> = {}) {
  return buildBrokerApp({
    config: testConfig(),
    logger: testLogger(),
    docker: stubDocker(dockerOverrides),
  });
}

describe('GET /v1/archive/:volumeKey', () => {
  it('rejects a request with no secret header', async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/v1/archive/mail' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown volume key', async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/archive/not-a-real-volume',
      headers: { [BROKER_SECRET_HEADER]: SECRET },
    });
    expect(response.statusCode).toBe(400);
  });

  it('streams back exactly what getContainerArchive returns, untouched', async () => {
    const tarBytes = Buffer.from('fake-tar-bytes-for-mail-volume');
    let requestedId: string | undefined;
    let requestedPath: string | undefined;

    const app = buildTestApp({
      getContainerArchive: async (id, path) => {
        requestedId = id;
        requestedPath = path;
        return Readable.from([tarBytes]);
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/archive/mail',
      headers: { [BROKER_SECRET_HEADER]: SECRET },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-tar');
    expect(response.rawPayload.equals(tarBytes)).toBe(true);
    expect(requestedId).toBe('mailserver-id');
    expect(requestedPath).toBe('/var/mail');
  });

  it('maps each symbolic key to its own fixed container path', async () => {
    const seenPaths: string[] = [];
    const app = buildTestApp({
      getContainerArchive: async (_id, path) => {
        seenPaths.push(path);
        return Readable.from([Buffer.from('x')]);
      },
    });

    for (const key of ['mail', 'mailState', 'mailLog', 'dmsConfig']) {
      await app.inject({
        method: 'GET',
        url: `/v1/archive/${key}`,
        headers: { [BROKER_SECRET_HEADER]: SECRET },
      });
    }

    expect(seenPaths).toEqual([
      '/var/mail',
      '/var/mail-state',
      '/var/log/mail',
      '/tmp/docker-mailserver',
    ]);
  });

  it('refuses when the managed container does not resolve', async () => {
    const app = buildTestApp({ listContainers: async () => [] });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/archive/mail',
      headers: { [BROKER_SECRET_HEADER]: SECRET },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('PUT /v1/archive/:volumeKey', () => {
  it('rejects a request with no secret header', async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/archive/mail',
      headers: { 'content-type': 'application/x-tar' },
      payload: Buffer.from('irrelevant'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('streams the request body through to putContainerArchive, untouched', async () => {
    const uploaded = Buffer.from('restore-tar-bytes');
    let receivedPath: string | undefined;
    let receivedBytes: Buffer | undefined;

    const app = buildTestApp({
      putContainerArchive: async (_id, path, tarStream) => {
        receivedPath = path;
        const chunks: Buffer[] = [];
        for await (const chunk of tarStream) {
          chunks.push(chunk as Buffer);
        }
        receivedBytes = Buffer.concat(chunks);
      },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/archive/dmsConfig',
      headers: { [BROKER_SECRET_HEADER]: SECRET, 'content-type': 'application/x-tar' },
      payload: uploaded,
    });

    expect(response.statusCode).toBe(204);
    expect(receivedPath).toBe('/tmp/docker-mailserver');
    expect(receivedBytes?.equals(uploaded)).toBe(true);
  });

  it('rejects an unknown volume key', async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/archive/not-a-real-volume',
      headers: { [BROKER_SECRET_HEADER]: SECRET, 'content-type': 'application/x-tar' },
      payload: Buffer.from('x'),
    });
    expect(response.statusCode).toBe(400);
  });
});
