/**
 * Direct unit tests for the env/labels/cmd filtering rule
 * `image-swap-spec.ts`'s header defines — the pure function, entry by
 * entry. `updater.test.ts` covers the same rule end to end through the
 * state machine and the fake's Docker-style merge.
 */
import { describe, expect, it } from 'vitest';
import type { RawContainerRecreateSpec, RawImageConfig } from '../docker-types.js';
import { buildImageSwapSpec, withoutImageInheritedEnv } from './image-swap-spec.js';

const OLD_IMAGE: RawImageConfig = {
  id: 'sha256:old',
  env: [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'NODE_VERSION=24.1.0',
    'YARN_VERSION=1.22.22',
    'NODE_ENV=production',
    'DWG_VERSION=1.0.1',
    'DWG_IMAGE_ORIGIN=registry',
    'DATA_DIR=/app/data',
    'STATIC_DIR=/app/apps/web/dist',
  ],
  labels: {
    'org.opencontainers.image.version': '1.0.1',
    'org.opencontainers.image.title': 'docker-webmail-gui-server',
    maintainer: 'image-maintainer',
  },
  cmd: ['node', 'apps/server/dist/index.js'],
};

function capturedSpec(overrides: Partial<RawContainerRecreateSpec>): RawContainerRecreateSpec {
  return {
    name: 'dwg-server',
    image: 'sha256:old',
    env: [],
    labels: {},
    cmd: null,
    hostConfig: { GroupAdd: ['999'], ReadonlyRootfs: true },
    networkingConfig: { 'dwg-broker': {} },
    ...overrides,
  };
}

describe('withoutImageInheritedEnv', () => {
  it('drops every entry inherited verbatim from the old image', () => {
    expect(withoutImageInheritedEnv(OLD_IMAGE.env, OLD_IMAGE)).toEqual([]);
  });

  it('keeps operator entries the image does not define at all', () => {
    const env = [
      'COOKIE_SECRET=s3cret',
      'BROKER_SHARED_SECRET=shared',
      'BROKER_URL=http://broker:4000',
      'PORT=3000',
      'DANGEROUSLY_OVERRIDE_SELF_UPDATE_REGISTRY=localhost:5000/owner',
      ...OLD_IMAGE.env,
    ];
    expect(withoutImageInheritedEnv(env, OLD_IMAGE)).toEqual([
      'COOKIE_SECRET=s3cret',
      'BROKER_SHARED_SECRET=shared',
      'BROKER_URL=http://broker:4000',
      'PORT=3000',
      'DANGEROUSLY_OVERRIDE_SELF_UPDATE_REGISTRY=localhost:5000/owner',
    ]);
  });

  it('keeps an operator override of an image-defined functional key (value differs from the image)', () => {
    expect(
      withoutImageInheritedEnv(
        ['NODE_ENV=development', 'DATA_DIR=/srv/dwg', 'PATH=/opt/bin:/usr/bin'],
        OLD_IMAGE,
      ),
    ).toEqual(['NODE_ENV=development', 'DATA_DIR=/srv/dwg', 'PATH=/opt/bin:/usr/bin']);
  });

  it('always drops DWG_VERSION/DWG_IMAGE_ORIGIN, including stale values that no longer match the image (an already-polluted container)', () => {
    expect(
      withoutImageInheritedEnv(
        ['DWG_VERSION=1.0.0', 'DWG_IMAGE_ORIGIN=source', 'COOKIE_SECRET=s3cret'],
        OLD_IMAGE,
      ),
    ).toEqual(['COOKIE_SECRET=s3cret']);
  });

  it('always drops the base image’s NODE_VERSION/YARN_VERSION markers, even from an older base image', () => {
    expect(
      withoutImageInheritedEnv(
        ['NODE_VERSION=22.0.0', 'YARN_VERSION=1.0.0', 'PORT=3000'],
        OLD_IMAGE,
      ),
    ).toEqual(['PORT=3000']);
  });

  it('with no image to compare against, drops only the provenance keys and keeps everything else', () => {
    expect(
      withoutImageInheritedEnv(
        ['DWG_VERSION=1.0.0', 'NODE_ENV=production', 'PATH=/usr/bin', 'PORT=3000'],
        null,
      ),
    ).toEqual(['NODE_ENV=production', 'PATH=/usr/bin', 'PORT=3000']);
  });

  it('matches on the full KEY=VALUE entry, not a key prefix, and tolerates entries without "="', () => {
    expect(
      withoutImageInheritedEnv(
        ['DWG_VERSION_NOTE=kept', 'NODE_ENV=production-ish', 'BARE_KEY'],
        OLD_IMAGE,
      ),
    ).toEqual(['DWG_VERSION_NOTE=kept', 'NODE_ENV=production-ish', 'BARE_KEY']);
  });
});

describe('buildImageSwapSpec', () => {
  it('swaps the image, filters env/labels/cmd, and leaves name/hostConfig/networkingConfig untouched', () => {
    const captured = capturedSpec({
      env: ['COOKIE_SECRET=s3cret', ...OLD_IMAGE.env],
      labels: {
        ...OLD_IMAGE.labels,
        'com.docker.compose.project': 'docker-webmail-gui',
        'com.docker.compose.service': 'server',
      },
      cmd: ['node', 'apps/server/dist/index.js'],
    });

    const spec = buildImageSwapSpec(captured, OLD_IMAGE, 'ghcr.io/o/server:1.0.2');

    expect(spec).toEqual({
      name: 'dwg-server',
      image: 'ghcr.io/o/server:1.0.2',
      env: ['COOKIE_SECRET=s3cret'],
      labels: {
        'com.docker.compose.project': 'docker-webmail-gui',
        'com.docker.compose.service': 'server',
      },
      cmd: null,
      hostConfig: captured.hostConfig,
      networkingConfig: captured.networkingConfig,
    });
  });

  it('never mutates the captured spec (it is also the rollback plan)', () => {
    const captured = capturedSpec({
      env: ['COOKIE_SECRET=s3cret', ...OLD_IMAGE.env],
      labels: { ...OLD_IMAGE.labels },
      cmd: [...(OLD_IMAGE.cmd ?? [])],
    });
    const snapshot = structuredClone(captured);

    buildImageSwapSpec(captured, OLD_IMAGE, 'ghcr.io/o/server:1.0.2');

    expect(captured).toEqual(snapshot);
  });

  it('drops stale OCI image labels even when they differ from the image, keeps a changed non-OCI label', () => {
    const spec = buildImageSwapSpec(
      capturedSpec({
        labels: { 'org.opencontainers.image.version': '1.0.0', maintainer: 'operator-override' },
      }),
      OLD_IMAGE,
      'ghcr.io/o/server:1.0.2',
    );
    expect(spec.labels).toEqual({ maintainer: 'operator-override' });
  });

  it('keeps a cmd that differs from the old image’s CMD (an explicit override), and any cmd when the image is unknown', () => {
    const custom = ['node', '--inspect', 'apps/server/dist/index.js'];
    expect(buildImageSwapSpec(capturedSpec({ cmd: custom }), OLD_IMAGE, 'x:1').cmd).toEqual(custom);
    expect(buildImageSwapSpec(capturedSpec({ cmd: OLD_IMAGE.cmd }), null, 'x:1').cmd).toEqual(
      OLD_IMAGE.cmd,
    );
  });
});
