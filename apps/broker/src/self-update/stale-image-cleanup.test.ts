import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { DockerApi, RawContainerListItem, RawImage } from '../docker-types.js';
import { PANEL_BROKER_REPOSITORY, PANEL_SERVER_REPOSITORY } from './image-refs.js';
import { isStalePanelImage, removeStalePanelImages } from './stale-image-cleanup.js';

const SERVER = PANEL_SERVER_REPOSITORY;
const BROKER = PANEL_BROKER_REPOSITORY;
const REPOSITORIES = [SERVER, BROKER];

function image(id: string, repoTags: readonly string[]): RawImage {
  return { id, repoTags, sizeBytes: 0, createdAt: 0, labels: {} };
}

function container(id: string, imageRef: string): RawContainerListItem {
  return {
    id,
    names: [id],
    image: imageRef,
    state: 'running',
    status: 'Up',
    labels: {},
    createdAt: 0,
    mountVolumeNames: [],
    networkNames: [],
  };
}

/** The image set left on the host this report was written from: two earlier releases next to the running one. */
const HOST_IMAGES = [
  image('sha256:server-121', [`${SERVER}:1.2.1`]),
  image('sha256:broker-121', [`${BROKER}:1.2.1`]),
  image('sha256:server-110', [`${SERVER}:1.1.0`]),
  image('sha256:broker-110', [`${BROKER}:1.1.0`, `${BROKER}:1.1`]),
  image('sha256:broker-010', [`${BROKER}:0.1.0`]),
  image('sha256:dms', ['ghcr.io/docker-mailserver/docker-mailserver:16']),
];

function harness(images: readonly RawImage[], containers: readonly RawContainerListItem[]) {
  const removeImage = vi.fn(async (_reference: string) => undefined);
  const docker = {
    listImages: async () => images,
    listContainers: async () => containers,
    removeImage,
  } as unknown as DockerApi;
  return {
    removeImage,
    run: () =>
      removeStalePanelImages({
        docker,
        runningVersion: '1.2.1',
        repositories: REPOSITORIES,
        logger: pino({ level: 'silent' }),
      }),
  };
}

describe('isStalePanelImage', () => {
  it('is true only for a panel release older than the running one', () => {
    expect(isStalePanelImage(image('a', [`${SERVER}:1.1.0`]), REPOSITORIES, '1.2.1')).toBe(true);
    expect(isStalePanelImage(image('a', [`${SERVER}:1.2.1`]), REPOSITORIES, '1.2.1')).toBe(false);
    expect(isStalePanelImage(image('a', [`${SERVER}:1.10.0`]), REPOSITORIES, '1.9.9')).toBe(false);
    expect(isStalePanelImage(image('a', [`${SERVER}:1.9.9`]), REPOSITORIES, '1.10.0')).toBe(true);
  });

  it('leaves an image alone when any tag is outside the panel repositories', () => {
    expect(
      isStalePanelImage(image('a', [`${SERVER}:1.1.0`, 'my/keep:old']), REPOSITORIES, '1.2.1'),
    ).toBe(false);
    expect(
      isStalePanelImage(
        image('a', ['ghcr.io/docker-mailserver/docker-mailserver:15']),
        REPOSITORIES,
        '1.2.1',
      ),
    ).toBe(false);
  });

  it('needs an exact version tag, and every version tag must be older', () => {
    expect(isStalePanelImage(image('a', [`${SERVER}:latest`]), REPOSITORIES, '1.2.1')).toBe(false);
    expect(isStalePanelImage(image('a', []), REPOSITORIES, '1.2.1')).toBe(false);
    expect(
      isStalePanelImage(image('a', [`${SERVER}:1.1.0`, `${SERVER}:1.3.0`]), REPOSITORIES, '1.2.1'),
    ).toBe(false);
  });

  it('removes nothing when the running version is not an exact release', () => {
    expect(isStalePanelImage(image('a', [`${SERVER}:1.1.0`]), REPOSITORIES, 'dev')).toBe(false);
  });

  it('reads a registry with a port correctly', () => {
    const repository = 'localhost:5000/docker-webmail-gui-server';
    expect(isStalePanelImage(image('a', [`${repository}:1.0.0`]), [repository], '1.2.1')).toBe(
      true,
    );
  });
});

describe('removeStalePanelImages', () => {
  it('removes every tag of each earlier release, and nothing else', async () => {
    const { run, removeImage } = harness(HOST_IMAGES, [
      container('dwg-server', `${SERVER}:1.2.1`),
      container('dwg-broker', `${BROKER}:1.2.1`),
    ]);
    await expect(run()).resolves.toEqual([
      `${SERVER}:1.1.0`,
      `${BROKER}:1.1.0`,
      `${BROKER}:1.1`,
      `${BROKER}:0.1.0`,
    ]);
    expect(removeImage).toHaveBeenCalledTimes(4);
  });

  it('keeps an old image a container still uses — the updater running on the previous broker image', async () => {
    const { run, removeImage } = harness(HOST_IMAGES, [
      container('dwg-server', `${SERVER}:1.2.1`),
      container('dwg-broker', `${BROKER}:1.2.1`),
      container('dwg-self-update-updater', `${BROKER}:1.1.0`),
      // A rollback container created from a bare image id.
      container('rolled-back', 'sha256:server-110'),
    ]);
    await expect(run()).resolves.toEqual([`${BROKER}:0.1.0`]);
    expect(removeImage).toHaveBeenCalledTimes(1);
  });

  it('stops on an image whose tag Docker refuses to remove, and carries on with the next', async () => {
    const { run, removeImage } = harness(HOST_IMAGES, []);
    removeImage.mockImplementationOnce(async () => {
      throw new Error('conflict: unable to remove repository reference');
    });
    // server:1.1.0 refused; broker 1.1.0 (both tags) and 0.1.0 still go.
    await expect(run()).resolves.toEqual([`${BROKER}:1.1.0`, `${BROKER}:1.1`, `${BROKER}:0.1.0`]);
  });
});
