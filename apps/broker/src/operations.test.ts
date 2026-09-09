/**
 * Direct unit tests for the visibility filter and `panel.restart`, calling
 * `handleOperation` with a hand-built `DockerApi` stub. The app-level HTTP
 * tests (`app.test.ts`) cover the route/auth/response-validation path;
 * this file covers the operation logic itself — which containers/images/
 * volumes/networks the broker will and will not surface, and the two
 * refusals that keep `panel.restart` from ever hitting the broker.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { handleOperation, type OperationDeps } from './operations.js';
import type {
  DockerApi,
  RawContainerListItem,
  RawContainerRecreateSpec,
  RawImage,
  RawNetwork,
  RawVolume,
} from './docker-types.js';

function container(overrides: Partial<RawContainerListItem>): RawContainerListItem {
  return {
    id: `id-${overrides.names?.[0] ?? 'x'}`,
    names: ['x'],
    image: 'image:latest',
    state: 'running',
    status: 'Up',
    labels: {},
    createdAt: 1_700_000_000,
    mountVolumeNames: [],
    networkNames: [],
    ...overrides,
  };
}

// The shared-host scenario from the task: mail server + panel + a roundcube
// stack, alongside unrelated host containers that must never be visible.
const HOST_CONTAINERS: readonly RawContainerListItem[] = [
  container({
    names: ['mailserver'],
    image: 'ghcr.io/docker-mailserver/docker-mailserver:latest',
    mountVolumeNames: ['dms-mail-data'],
    networkNames: ['mailserver_net'],
  }),
  container({
    names: ['dwg-server'],
    image: 'ghcr.io/arvinrahnama/docker-webmail-gui-server:0.2.0',
    mountVolumeNames: ['dwg-server-data', 'dwg-server-backups'],
    networkNames: ['dwg-frontend', 'dwg-broker'],
  }),
  container({
    names: ['dwg-broker'],
    image: 'ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.2.0',
    networkNames: ['dwg-broker'],
  }),
  container({
    names: ['roundcube'],
    image: 'roundcube/roundcubemail:latest',
    networkNames: ['mailserver_net'],
  }),
  container({
    names: ['roundcube-db'],
    image: 'mariadb:11',
    mountVolumeNames: ['roundcube-db-data'],
    networkNames: ['mailserver_net'],
  }),
  container({
    names: ['nginx-proxy-manager'],
    image: 'jc21/nginx-proxy-manager',
    mountVolumeNames: ['npm-data'],
    networkNames: ['npm_default'],
  }),
  container({
    names: ['owner-website'],
    image: 'owner/site:latest',
    mountVolumeNames: ['site-data'],
    networkNames: ['npm_default'],
  }),
];

const HOST_IMAGES: readonly RawImage[] = [
  {
    id: 'sha256:mail',
    repoTags: ['ghcr.io/docker-mailserver/docker-mailserver:latest'],
    sizeBytes: 1,
    createdAt: 1,
    labels: {},
  },
  {
    id: 'sha256:server',
    repoTags: ['ghcr.io/arvinrahnama/docker-webmail-gui-server:0.2.0'],
    sizeBytes: 1,
    createdAt: 1,
    labels: {},
  },
  {
    id: 'sha256:round',
    repoTags: ['roundcube/roundcubemail:latest'],
    sizeBytes: 1,
    createdAt: 1,
    labels: {},
  },
  { id: 'sha256:mariadb', repoTags: ['mariadb:11'], sizeBytes: 1, createdAt: 1, labels: {} },
  {
    id: 'sha256:nginx',
    repoTags: ['jc21/nginx-proxy-manager:latest'],
    sizeBytes: 1,
    createdAt: 1,
    labels: {},
  },
  { id: 'sha256:dangling', repoTags: [], sizeBytes: 1, createdAt: 1, labels: {} },
];

const HOST_VOLUMES: readonly RawVolume[] = [
  'dms-mail-data',
  'dwg-server-data',
  'dwg-server-backups',
  'roundcube-db-data',
  'npm-data',
  'site-data',
].map((name) => ({
  name,
  driver: 'local',
  mountpoint: `/var/lib/docker/volumes/${name}`,
  labels: {},
}));

const HOST_NETWORKS: readonly RawNetwork[] = [
  'mailserver_net',
  'dwg-frontend',
  'dwg-broker',
  'npm_default',
  'bridge',
  'host',
].map((name) => ({ id: `net-${name}`, name, driver: 'bridge', scope: 'local' }));

function stubDocker(overrides: Partial<DockerApi> = {}): DockerApi {
  return {
    ping: vi.fn(),
    version: vi.fn(),
    info: vi.fn(),
    df: vi.fn(),
    listContainers: vi.fn(async () => HOST_CONTAINERS),
    inspectContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    restartContainer: vi.fn(async () => undefined),
    statsContainer: vi.fn(),
    logsContainer: vi.fn(),
    listImages: vi.fn(async () => HOST_IMAGES),
    listVolumes: vi.fn(async () => HOST_VOLUMES),
    listNetworks: vi.fn(async () => HOST_NETWORKS),
    removeVolume: vi.fn(),
    pruneImages: vi.fn(),
    execContainer: vi.fn(),
    getContainerArchive: vi.fn(),
    putContainerArchive: vi.fn(),
    pullImage: vi.fn(async () => undefined),
    inspectContainerForRecreate: vi.fn(),
    createContainer: vi.fn(),
    removeContainer: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DockerApi;
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function deps(docker: DockerApi): OperationDeps {
  return {
    docker,
    dms: { containerName: 'mailserver', containerLabel: null },
    panelServer: { containerName: 'dwg-server', containerLabel: null },
    panelBroker: { containerName: 'dwg-broker', containerLabel: null },
    visibleServicePatterns: ['*mailserver*', 'roundcube*', '*docker-webmail-gui*'],
    dangerouslyOverrideSelfUpdateRegistry: null,
    logger,
  };
}

describe('container.list — visibility filter', () => {
  it('returns only webmail services, never unrelated host containers', async () => {
    const result = (await handleOperation(
      { operation: 'container.list', all: true },
      deps(stubDocker()),
    )) as {
      containers: { names: string[] }[];
    };
    const names = result.containers.flatMap((c) => c.names).sort();
    expect(names).toEqual(['dwg-broker', 'dwg-server', 'mailserver', 'roundcube', 'roundcube-db']);
    expect(names).not.toContain('nginx-proxy-manager');
    expect(names).not.toContain('owner-website');
  });
});

describe('image.list — visibility filter', () => {
  it('shows pattern-matched images and images of visible containers, hides the rest and dangling', async () => {
    const result = (await handleOperation({ operation: 'image.list' }, deps(stubDocker()))) as {
      images: { id: string; repoTags: string[] }[];
    };
    const ids = result.images.map((i) => i.id).sort();
    // mail/server/round by pattern; mariadb because roundcube-db (visible) runs it.
    expect(ids).toEqual(['sha256:mail', 'sha256:mariadb', 'sha256:round', 'sha256:server']);
    expect(ids).not.toContain('sha256:nginx');
    expect(ids).not.toContain('sha256:dangling');
  });
});

describe('volume.list — derived from visible containers', () => {
  it('shows only volumes mounted by a visible container', async () => {
    const result = (await handleOperation({ operation: 'volume.list' }, deps(stubDocker()))) as {
      volumes: { name: string }[];
    };
    const names = result.volumes.map((v) => v.name).sort();
    expect(names).toEqual([
      'dms-mail-data',
      'dwg-server-backups',
      'dwg-server-data',
      'roundcube-db-data',
    ]);
    expect(names).not.toContain('npm-data');
    expect(names).not.toContain('site-data');
  });
});

describe('network.list — derived from visible containers', () => {
  it('shows only networks a visible container is attached to', async () => {
    const result = (await handleOperation({ operation: 'network.list' }, deps(stubDocker()))) as {
      networks: { name: string }[];
    };
    const names = result.networks.map((n) => n.name).sort();
    expect(names).toEqual(['dwg-broker', 'dwg-frontend', 'mailserver_net']);
    expect(names).not.toContain('bridge');
    expect(names).not.toContain('npm_default');
  });
});

describe('panel.restart', () => {
  it('restarts the resolved panel server container', async () => {
    const restartContainer = vi.fn(async () => undefined);
    const docker = stubDocker({ restartContainer });
    const result = await handleOperation({ operation: 'panel.restart' }, deps(docker));
    expect(result).toEqual({ ok: true });
    expect(restartContainer).toHaveBeenCalledExactlyOnceWith('id-dwg-server');
  });

  it('refuses (never restarts) when the panel server does not resolve to exactly one match', async () => {
    const restartContainer = vi.fn(async () => undefined);
    const docker = stubDocker({
      restartContainer,
      listContainers: vi.fn(async () => HOST_CONTAINERS.filter((c) => c.names[0] !== 'dwg-server')),
    });
    await expect(handleOperation({ operation: 'panel.restart' }, deps(docker))).rejects.toThrow(
      /could not be resolved/i,
    );
    expect(restartContainer).not.toHaveBeenCalled();
  });

  it('refuses to restart the broker even if the panel-server identity resolves to it', async () => {
    const restartContainer = vi.fn(async () => undefined);
    const docker = stubDocker({ restartContainer });
    // Misconfiguration: PANEL_SERVER points at the broker container.
    const misconfig: OperationDeps = {
      ...deps(docker),
      panelServer: { containerName: 'dwg-broker', containerLabel: null },
    };
    await expect(handleOperation({ operation: 'panel.restart' }, misconfig)).rejects.toThrow(
      /broker/i,
    );
    expect(restartContainer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Panel self-update (docs/design/self-update.md, SU-B). Its own fixture set,
// deliberately not a reuse of HOST_CONTAINERS/HOST_IMAGES above: those
// model `image` as a tag string for the (unrelated) visibility-filter
// tests, but a real container's `image` field is a content digest — the
// version-resolution join under test here needs that distinction to be
// real, exactly as `updates.service.ts` relies on it for the (also
// unrelated) docker-mailserver comparison.
// ---------------------------------------------------------------------------

const SELF_UPDATE_CONTAINERS: readonly RawContainerListItem[] = [
  container({ names: ['mailserver'], image: 'sha256:mail-digest' }),
  container({ names: ['dwg-server'], image: 'sha256:server-digest' }),
  container({ names: ['dwg-broker'], image: 'sha256:broker-digest' }),
];

const SELF_UPDATE_IMAGES: readonly RawImage[] = [
  {
    id: 'sha256:mail-digest',
    repoTags: ['ghcr.io/docker-mailserver/docker-mailserver:latest'],
    sizeBytes: 1,
    createdAt: 1,
    labels: {},
  },
  {
    id: 'sha256:server-digest',
    // A real release publishes the full version, the minor-only alias,
    // and `latest` all pointing at the same id (docs/design/
    // self-update.md §9.2) — only the full version should ever be picked.
    repoTags: [
      'ghcr.io/arvinrahnama/docker-webmail-gui-server:0.3.0',
      'ghcr.io/arvinrahnama/docker-webmail-gui-server:0.3',
      'ghcr.io/arvinrahnama/docker-webmail-gui-server:latest',
    ],
    sizeBytes: 1,
    createdAt: 1,
    labels: {},
  },
  {
    id: 'sha256:broker-digest',
    repoTags: [
      'ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.3.0',
      'ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.3',
      'ghcr.io/arvinrahnama/docker-webmail-gui-broker:latest',
    ],
    sizeBytes: 1,
    createdAt: 1,
    labels: {},
  },
];

/**
 * `inspectContainerForRecreate` fixtures, keyed by container id (SU-E,
 * docs/design/self-update.md §9.8) — what `panel.selfUpdateCheck` now
 * reads `serverVersion`/`brokerVersion`/`updatePossible` from, in place
 * of the old `listImages()` repo-tag join. `SELF_UPDATE_IMAGES` above is
 * kept only as an unrelated-fixture backdrop (still returned by
 * `listImages()`, still never consulted by this handler any more) — not
 * because this handler still needs it.
 */
function recreateSpec(overrides: Partial<RawContainerRecreateSpec>): RawContainerRecreateSpec {
  return {
    name: 'x',
    image: 'image:latest',
    env: ['DWG_VERSION=0.3.0', 'DWG_IMAGE_ORIGIN=registry'],
    labels: {},
    cmd: null,
    hostConfig: {},
    networkingConfig: {},
    ...overrides,
  };
}

/**
 * Broker's own `hostConfig`/`networkingConfig` fixture — modelled on what
 * `docker/compose.yaml` actually configures for `broker:` (the docker-
 * socket bind, `group_add: [DOCKER_GID]`, `cap_drop: ALL`,
 * `read_only: true`, one attached network), specifically so
 * `panel.selfUpdateApply`'s tests below can assert `launchUpdater`
 * receives and correctly clones every one of these — `GroupAdd` above
 * all, since a hand-composed `hostConfig` silently dropping it is the
 * real-daemon bug SU-F's first real run found (`launch-updater.ts`'s own
 * header).
 */
const BROKER_HOST_CONFIG = {
  Binds: ['/var/run/docker.sock:/var/run/docker.sock:rw'],
  GroupAdd: ['999'],
  CapDrop: ['ALL'],
  ReadonlyRootfs: true,
};
const BROKER_NETWORKING_CONFIG = { EndpointsConfig: { 'dwg-broker': {} } };

const SELF_UPDATE_RECREATE_SPECS: Readonly<Record<string, RawContainerRecreateSpec>> = {
  'id-dwg-server': recreateSpec({
    name: 'dwg-server',
    image: 'ghcr.io/arvinrahnama/docker-webmail-gui-server:0.3.0',
  }),
  'id-dwg-broker': recreateSpec({
    name: 'dwg-broker',
    image: 'ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.3.0',
    hostConfig: BROKER_HOST_CONFIG,
    networkingConfig: BROKER_NETWORKING_CONFIG,
  }),
};

function selfUpdateDocker(
  overrides: Partial<DockerApi> = {},
  recreateSpecs: Readonly<Record<string, RawContainerRecreateSpec>> = SELF_UPDATE_RECREATE_SPECS,
): DockerApi {
  return stubDocker({
    listContainers: vi.fn(async () => SELF_UPDATE_CONTAINERS),
    listImages: vi.fn(async () => SELF_UPDATE_IMAGES),
    inspectContainerForRecreate: vi.fn(async (id: string) => {
      const spec = recreateSpecs[id];
      if (spec === undefined)
        throw new Error(`selfUpdateDocker: no recreate spec fixture for ${id}`);
      return spec;
    }),
    ...overrides,
  });
}

describe('panel.selfUpdateCheck', () => {
  it("reports both containers' current versions when they resolve cleanly, both registry-origin", async () => {
    const result = await handleOperation(
      { operation: 'panel.selfUpdateCheck' },
      deps(selfUpdateDocker()),
    );
    expect(result).toEqual({
      serverVersion: '0.3.0',
      brokerVersion: '0.3.0',
      updatePossible: true,
      reason: null,
    });
  });

  it('reports updatePossible: false, honestly (never a fabricated version), when the baked version marker is missing entirely', async () => {
    // Simulates an image built before SU-E shipped: no DWG_VERSION/
    // DWG_IMAGE_ORIGIN in its env at all.
    const docker = selfUpdateDocker(
      {},
      {
        'id-dwg-server': recreateSpec({ name: 'dwg-server', env: ['PATH=/usr/bin'] }),
        'id-dwg-broker': recreateSpec({ name: 'dwg-broker', env: ['PATH=/usr/bin'] }),
      },
    );
    const result = (await handleOperation(
      { operation: 'panel.selfUpdateCheck' },
      deps(docker),
    )) as {
      serverVersion: string | null;
      brokerVersion: string | null;
      updatePossible: boolean;
      reason: string | null;
    };
    expect(result.serverVersion).toBeNull();
    expect(result.brokerVersion).toBeNull();
    expect(result.updatePossible).toBe(false);
    expect(result.reason).toMatch(/baked version|predates/i);
  });

  it('reports updatePossible: false with the source-install reason when the server container is source-origin, even though its version resolves', async () => {
    const docker = selfUpdateDocker(
      {},
      {
        'id-dwg-server': recreateSpec({
          name: 'dwg-server',
          env: ['DWG_VERSION=0.3.0', 'DWG_IMAGE_ORIGIN=source'],
        }),
        'id-dwg-broker': SELF_UPDATE_RECREATE_SPECS['id-dwg-broker']!,
      },
    );
    const result = (await handleOperation(
      { operation: 'panel.selfUpdateCheck' },
      deps(docker),
    )) as {
      serverVersion: string | null;
      brokerVersion: string | null;
      updatePossible: boolean;
      reason: string | null;
    };
    // The version is still honestly reported — the refusal is about
    // origin, not about being unable to determine a version at all.
    expect(result.serverVersion).toBe('0.3.0');
    expect(result.brokerVersion).toBe('0.3.0');
    expect(result.updatePossible).toBe(false);
    expect(result.reason).toMatch(/registry-image installs/i);
  });

  it('reports updatePossible: false when only the broker (not the server) is source-origin — either container refuses the whole check', async () => {
    const docker = selfUpdateDocker(
      {},
      {
        'id-dwg-server': SELF_UPDATE_RECREATE_SPECS['id-dwg-server']!,
        'id-dwg-broker': recreateSpec({
          name: 'dwg-broker',
          env: ['DWG_VERSION=0.3.0', 'DWG_IMAGE_ORIGIN=source'],
        }),
      },
    );
    const result = (await handleOperation(
      { operation: 'panel.selfUpdateCheck' },
      deps(docker),
    )) as { updatePossible: boolean; reason: string | null };
    expect(result.updatePossible).toBe(false);
    expect(result.reason).toMatch(/registry-image installs/i);
  });

  it('refuses when the panel identities do not each resolve to exactly one match', async () => {
    const docker = selfUpdateDocker({
      listContainers: vi.fn(async () =>
        SELF_UPDATE_CONTAINERS.filter((c) => c.names[0] !== 'dwg-broker'),
      ),
    });
    await expect(
      handleOperation({ operation: 'panel.selfUpdateCheck' }, deps(docker)),
    ).rejects.toThrow(/could not be resolved/i);
  });

  it('refuses when a panel identity resolves to the mail container', async () => {
    const misconfig: OperationDeps = {
      ...deps(selfUpdateDocker()),
      panelBroker: { containerName: 'mailserver', containerLabel: null },
    };
    await expect(
      handleOperation({ operation: 'panel.selfUpdateCheck' }, misconfig),
    ).rejects.toThrow(/mail container/i);
  });

  it('refuses when panelServer and panelBroker resolve to the same container', async () => {
    const misconfig: OperationDeps = {
      ...deps(selfUpdateDocker()),
      panelBroker: { containerName: 'dwg-server', containerLabel: null },
    };
    await expect(
      handleOperation({ operation: 'panel.selfUpdateCheck' }, misconfig),
    ).rejects.toThrow(/same container/i);
  });
});

describe('panel.selfUpdateApply', () => {
  it('launches the updater with the composed image refs and the resolved container names, never the client-supplied identity verbatim', async () => {
    const createContainer = vi.fn(async () => ({ id: 'updater-id' }));
    const startContainer = vi.fn(async () => undefined);
    const docker = selfUpdateDocker({ createContainer, startContainer });

    const result = await handleOperation(
      { operation: 'panel.selfUpdateApply', targetVersion: '0.4.0' },
      deps(docker),
    );

    expect(result).toEqual({ started: true });
    expect(createContainer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'dwg-self-update-updater',
        // The broker's OWN currently-running image — not either target,
        // neither of which is pulled yet at launch time. Sourced from the
        // *cloned spec* (`inspectContainerForRecreate`), not a plain
        // `listContainers()` lookup — see the next test for why that
        // distinction is load-bearing, not cosmetic.
        image: 'ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.3.0',
        cmd: ['node', 'apps/broker/dist/self-update/updater-entrypoint.js'],
        env: [
          'DWG_SELF_UPDATE_SERVER_CONTAINER_NAME=dwg-server',
          'DWG_SELF_UPDATE_BROKER_CONTAINER_NAME=dwg-broker',
          'DWG_SELF_UPDATE_SERVER_IMAGE_REF=ghcr.io/arvinrahnama/docker-webmail-gui-server:0.4.0',
          'DWG_SELF_UPDATE_BROKER_IMAGE_REF=ghcr.io/arvinrahnama/docker-webmail-gui-broker:0.4.0',
        ],
      }),
    );
    expect(startContainer).toHaveBeenCalledExactlyOnceWith('updater-id');
  });

  // The real-daemon bug SU-F's first real run found: a hand-composed
  // `hostConfig` (just `Binds` + `AutoRemove`) silently dropped
  // `GroupAdd` — the host's docker-group GID, `docker/compose.yaml`'s
  // `group_add:` on `broker:` itself — which is what actually lets the
  // non-root `dwg` user use the bind-mounted socket at all. The updater
  // launched fine and reported `{started:true}`, then got `EACCES` on its
  // very first Docker API call and `AutoRemove`d itself, leaving no
  // trace: neither panel container was ever touched. Fixed by cloning the
  // broker's own `hostConfig`/`networkingConfig` wholesale
  // (`launch-updater.ts`'s own header has the full account) instead of
  // hand-composing them — asserted here directly.
  it("clones the broker's own hostConfig/networkingConfig (GroupAdd included) into the updater's spec, appending only the one extra bind", async () => {
    const createContainer = vi.fn(async () => ({ id: 'updater-id' }));
    const startContainer = vi.fn(async () => undefined);
    const docker = selfUpdateDocker({ createContainer, startContainer });

    await handleOperation(
      { operation: 'panel.selfUpdateApply', targetVersion: '0.4.0' },
      deps(docker),
    );

    expect(createContainer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        hostConfig: {
          // The broker's own bind (the docker socket) is untouched, plus
          // exactly one more entry for the server-data volume — never a
          // hand-invented Binds array.
          Binds: ['/var/run/docker.sock:/var/run/docker.sock:rw', 'dwg-server-data:/app/data'],
          // Carried through completely unread/undecided-on, exactly as
          // captured — this is the field that was silently missing
          // before this fix.
          GroupAdd: ['999'],
          CapDrop: ['ALL'],
          ReadonlyRootfs: true,
          // The one field this operation adds on top of the clone.
          AutoRemove: true,
        },
        // The broker's own network attachment, cloned verbatim — the
        // updater is never left on Docker's default bridge network.
        networkingConfig: BROKER_NETWORKING_CONFIG,
      }),
    );
  });

  // SU-F: the real-daemon CI test's one broker seam. `deps.
  // dangerouslyOverrideSelfUpdateRegistry` is `null` in every other test
  // in this file (via the shared `deps()` helper) — this is the one
  // place it is set, proving it only ever changes the registry *host*
  // half of the two composed image references, never anything the
  // request itself carries (`targetVersion` alone still decides the
  // version half, exactly as every other test above shows).
  it('composes both target image refs against the overridden registry host when dangerouslyOverrideSelfUpdateRegistry is set', async () => {
    const createContainer = vi.fn(async () => ({ id: 'updater-id' }));
    const startContainer = vi.fn(async () => undefined);
    const docker = selfUpdateDocker({ createContainer, startContainer });
    const overridden: OperationDeps = {
      ...deps(docker),
      dangerouslyOverrideSelfUpdateRegistry: 'localhost:5000/arvinrahnama',
    };

    await handleOperation(
      { operation: 'panel.selfUpdateApply', targetVersion: '0.4.0' },
      overridden,
    );

    expect(createContainer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        env: [
          'DWG_SELF_UPDATE_SERVER_CONTAINER_NAME=dwg-server',
          'DWG_SELF_UPDATE_BROKER_CONTAINER_NAME=dwg-broker',
          'DWG_SELF_UPDATE_SERVER_IMAGE_REF=localhost:5000/arvinrahnama/docker-webmail-gui-server:0.4.0',
          'DWG_SELF_UPDATE_BROKER_IMAGE_REF=localhost:5000/arvinrahnama/docker-webmail-gui-broker:0.4.0',
        ],
      }),
    );
  });

  it('removes a stale leftover updater container by name before launching a fresh one', async () => {
    const removeContainer = vi.fn(async () => undefined);
    const createContainer = vi.fn(async () => ({ id: 'updater-id-2' }));
    const docker = selfUpdateDocker({
      listContainers: vi.fn(async () => [
        ...SELF_UPDATE_CONTAINERS,
        container({ names: ['dwg-self-update-updater'], image: 'sha256:broker-digest' }),
      ]),
      removeContainer,
      createContainer,
    });

    await handleOperation(
      { operation: 'panel.selfUpdateApply', targetVersion: '0.4.0' },
      deps(docker),
    );

    expect(removeContainer).toHaveBeenCalledExactlyOnceWith('id-dwg-self-update-updater', {
      force: true,
    });
  });

  it('refuses (never launches the updater) when a panel identity resolves to the mail container', async () => {
    const createContainer = vi.fn(async () => ({ id: 'updater-id' }));
    const docker = selfUpdateDocker({ createContainer });
    const misconfig: OperationDeps = {
      ...deps(docker),
      panelServer: { containerName: 'mailserver', containerLabel: null },
    };
    await expect(
      handleOperation({ operation: 'panel.selfUpdateApply', targetVersion: '0.4.0' }, misconfig),
    ).rejects.toThrow(/mail container/i);
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('refuses when the panel identities do not each resolve to exactly one match', async () => {
    const docker = selfUpdateDocker({
      listContainers: vi.fn(async () =>
        SELF_UPDATE_CONTAINERS.filter((c) => c.names[0] !== 'dwg-server'),
      ),
    });
    await expect(
      handleOperation({ operation: 'panel.selfUpdateApply', targetVersion: '0.4.0' }, deps(docker)),
    ).rejects.toThrow(/could not be resolved/i);
  });
});
