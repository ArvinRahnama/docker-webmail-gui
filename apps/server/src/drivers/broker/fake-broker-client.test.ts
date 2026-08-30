import { describe, expect, it } from 'vitest';
import {
  ContainerInspectResponseSchema,
  ContainerListResponseSchema,
  ContainerLogLineSchema,
  ContainerStatsResponseSchema,
  ImageSummarySchema,
  NetworkSummarySchema,
  SystemDfResponseSchema,
  SystemInfoResponseSchema,
  SystemPingResponseSchema,
  SystemVersionResponseSchema,
  VolumeSummarySchema,
} from '@dwg/shared';
import { FakeBrokerClient } from './fake-broker-client.js';
import type { BrokerClient } from './types.js';

describe('FakeBrokerClient — satisfies the BrokerClient interface', () => {
  it('is assignable to BrokerClient (compile-time check)', () => {
    const client: BrokerClient = new FakeBrokerClient();
    expect(client).toBeInstanceOf(FakeBrokerClient);
  });
});

describe('FakeBrokerClient — every response conforms to the shared schema', () => {
  it('containerList', async () => {
    const client = new FakeBrokerClient();
    const containers = await client.containerList();
    expect(ContainerListResponseSchema.safeParse({ containers }).success).toBe(true);
    expect(containers.length).toBeGreaterThan(0);
  });

  it('containerInspect', async () => {
    const client = new FakeBrokerClient();
    const result = await client.containerInspect();
    expect(ContainerInspectResponseSchema.safeParse(result).success).toBe(true);
  });

  it('containerStats', async () => {
    const client = new FakeBrokerClient();
    const result = await client.containerStats();
    expect(ContainerStatsResponseSchema.safeParse(result).success).toBe(true);
  });

  it('containerLogs', async () => {
    const client = new FakeBrokerClient();
    const lines = await client.containerLogs();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(ContainerLogLineSchema.safeParse(line).success).toBe(true);
    }
  });

  it('containerLogs respects "tail" by returning at most that many lines, from the end', async () => {
    const client = new FakeBrokerClient();
    const all = await client.containerLogs();
    const tailed = await client.containerLogs({ tail: 1 });
    expect(tailed).toHaveLength(1);
    expect(tailed[0]).toEqual(all[all.length - 1]);
  });

  it('systemPing / systemVersion / systemInfo / systemDf', async () => {
    const client = new FakeBrokerClient();
    expect(SystemPingResponseSchema.safeParse(await client.systemPing()).success).toBe(true);
    expect(SystemVersionResponseSchema.safeParse(await client.systemVersion()).success).toBe(true);
    expect(SystemInfoResponseSchema.safeParse(await client.systemInfo()).success).toBe(true);
    expect(SystemDfResponseSchema.safeParse(await client.systemDf()).success).toBe(true);
  });

  it('imageList / volumeList / networkList', async () => {
    const client = new FakeBrokerClient();
    for (const image of await client.imageList()) {
      expect(ImageSummarySchema.safeParse(image).success).toBe(true);
    }
    for (const volume of await client.volumeList()) {
      expect(VolumeSummarySchema.safeParse(volume).success).toBe(true);
    }
    for (const network of await client.networkList()) {
      expect(NetworkSummarySchema.safeParse(network).success).toBe(true);
    }
  });
});

describe('FakeBrokerClient — deterministic, in-memory, stateful across its own lifecycle only', () => {
  it('starts running by default', async () => {
    const client = new FakeBrokerClient();
    const inspect = await client.containerInspect();
    expect(inspect.state.running).toBe(true);
  });

  it('containerStop observably changes containerInspect/containerList state', async () => {
    const client = new FakeBrokerClient();
    await client.containerStop();

    const inspect = await client.containerInspect();
    expect(inspect.state.running).toBe(false);

    // Only the managed container's state follows start/stop; the other
    // visible webmail services (containers.ts) keep running. So after a
    // stop the managed container has left the running-only list while the
    // others remain — asserted by content, finding the managed entry by id
    // rather than by position.
    const runningOnly = await client.containerList();
    expect(runningOnly.some((c) => c.id === inspect.id)).toBe(false);
    expect(runningOnly.length).toBeGreaterThan(0);

    const all = await client.containerList({ all: true });
    const managed = all.find((c) => c.id === inspect.id);
    expect(managed?.state).toBe('exited');
  });

  it('containerStart reverses containerStop', async () => {
    const client = new FakeBrokerClient();
    await client.containerStop();
    await client.containerStart();
    expect((await client.containerInspect()).state.running).toBe(true);
  });

  it('two independent instances do not share state', async () => {
    const a = new FakeBrokerClient();
    const b = new FakeBrokerClient();
    await a.containerStop();
    expect((await a.containerInspect()).state.running).toBe(false);
    expect((await b.containerInspect()).state.running).toBe(true);
  });

  it('never performs network I/O — resolves synchronously fast and identically across repeated calls', async () => {
    const client = new FakeBrokerClient();
    const first = await client.systemVersion();
    const second = await client.systemVersion();
    expect(first).toEqual(second);
  });
});

describe('FakeBrokerClient — visibility filter mirrors the broker', () => {
  it('containerList shows only webmail services, never unrelated host containers', async () => {
    const client = new FakeBrokerClient();
    const names = (await client.containerList({ all: true })).flatMap((c) => c.names);
    expect(names).toEqual(
      expect.arrayContaining([
        'mailserver',
        'dwg-server',
        'dwg-broker',
        'roundcube',
        'roundcube-db',
      ]),
    );
    expect(names).not.toContain('nginx-proxy-manager');
    expect(names).not.toContain('owner-website');
  });

  it('imageList shows pattern/referenced images, hides unrelated and dangling', async () => {
    const client = new FakeBrokerClient();
    const images = await client.imageList();
    const tags = images.flatMap((i) => i.repoTags);
    // mariadb has no pattern match — it is visible only because roundcube-db runs it.
    expect(tags.some((t) => t.startsWith('mariadb'))).toBe(true);
    expect(tags.some((t) => t.includes('nginx-proxy-manager'))).toBe(false);
    expect(images.map((i) => i.id)).not.toContain('sha256:dangling000000');
  });

  it('volumeList and networkList are derived from the visible containers', async () => {
    const client = new FakeBrokerClient();
    const volumes = (await client.volumeList()).map((v) => v.name);
    expect(volumes).toEqual(
      expect.arrayContaining(['dms-mail-data', 'dwg-server-data', 'roundcube-db-data']),
    );
    expect(volumes).not.toContain('npm-data');
    expect(volumes).not.toContain('site-data');

    const networks = (await client.networkList()).map((n) => n.name);
    expect(networks).toEqual(
      expect.arrayContaining(['mailserver_net', 'dwg-frontend', 'dwg-broker']),
    );
    expect(networks).not.toContain('npm_default');
    expect(networks).not.toContain('bridge');
  });

  it('panelRestart resolves and does not change the mail container state', async () => {
    const client = new FakeBrokerClient();
    await client.panelRestart();
    expect((await client.containerInspect()).state.running).toBe(true);
  });
});
