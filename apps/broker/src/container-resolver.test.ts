import { describe, expect, it } from 'vitest';
import { ContainerResolutionError, resolveManagedContainer } from './container-resolver.js';
import type { DockerApi, RawContainerListItem } from './docker-types.js';

function container(overrides: Partial<RawContainerListItem>): RawContainerListItem {
  return {
    id: 'id-default',
    names: ['default'],
    image: 'image:latest',
    state: 'running',
    status: 'Up 1 hour',
    labels: {},
    createdAt: 1_700_000_000,
    mountVolumeNames: [],
    networkNames: [],
    ...overrides,
  };
}

function stubDocker(containers: readonly RawContainerListItem[]): DockerApi {
  return {
    ping: () => Promise.reject(new Error('not stubbed')),
    version: () => Promise.reject(new Error('not stubbed')),
    info: () => Promise.reject(new Error('not stubbed')),
    df: () => Promise.reject(new Error('not stubbed')),
    listContainers: async () => containers,
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
  };
}

describe('resolveManagedContainer — name-based resolution', () => {
  it('resolves the single exact name match', async () => {
    const docker = stubDocker([
      container({ id: 'abc', names: ['mailserver'] }),
      container({ id: 'def', names: ['other'] }),
    ]);

    const ref = await resolveManagedContainer(docker, {
      containerName: 'mailserver',
      containerLabel: null,
    });

    expect(ref).toEqual({ id: 'abc', name: 'mailserver' });
  });

  it('refuses a substring match — "mailserver" must not match "mailserver-old" or "not-mailserver"', async () => {
    const docker = stubDocker([
      container({ id: 'abc', names: ['mailserver-old'] }),
      container({ id: 'def', names: ['not-mailserver'] }),
    ]);

    await expect(
      resolveManagedContainer(docker, { containerName: 'mailserver', containerLabel: null }),
    ).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('refuses when no container matches at all (naming a container outside the allowlist)', async () => {
    const docker = stubDocker([container({ id: 'abc', names: ['unrelated'] })]);

    const error = await resolveManagedContainer(docker, {
      containerName: 'mailserver',
      containerLabel: null,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ContainerResolutionError);
    expect((error as ContainerResolutionError).reason).toBe('not-found');
  });

  it('refuses when the container list is empty', async () => {
    const docker = stubDocker([]);
    await expect(
      resolveManagedContainer(docker, { containerName: 'mailserver', containerLabel: null }),
    ).rejects.toBeInstanceOf(ContainerResolutionError);
  });
});

describe('resolveManagedContainer — label-based resolution', () => {
  it('takes precedence over name when configured, and resolves a single match', async () => {
    const docker = stubDocker([
      container({
        id: 'abc',
        names: ['some-generated-name'],
        labels: { 'com.dwg.role': 'mail' },
      }),
      container({ id: 'def', names: ['mailserver'], labels: {} }),
    ]);

    const ref = await resolveManagedContainer(docker, {
      containerName: 'mailserver',
      containerLabel: 'com.dwg.role=mail',
    });

    // Resolved via the label, not the (also-present) name match on the
    // *other* container — proves label truly takes precedence.
    expect(ref.id).toBe('abc');
  });

  it('refuses when multiple containers share the configured label (ambiguous)', async () => {
    const docker = stubDocker([
      container({ id: 'abc', labels: { 'com.dwg.role': 'mail' } }),
      container({ id: 'def', labels: { 'com.dwg.role': 'mail' } }),
    ]);

    const error = await resolveManagedContainer(docker, {
      containerName: 'mailserver',
      containerLabel: 'com.dwg.role=mail',
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ContainerResolutionError);
    expect((error as ContainerResolutionError).reason).toBe('ambiguous');
  });

  it('requires the label value to match exactly, not just the key', async () => {
    const docker = stubDocker([container({ id: 'abc', labels: { 'com.dwg.role': 'not-mail' } })]);

    await expect(
      resolveManagedContainer(docker, {
        containerName: 'mailserver',
        containerLabel: 'com.dwg.role=mail',
      }),
    ).rejects.toMatchObject({ reason: 'not-found' });
  });
});
