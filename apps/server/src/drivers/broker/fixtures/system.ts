/**
 * Fixture provenance: CONSTRUCTED from the documented `GET /_ping`, `GET
 * /version`, `GET /info` and `GET /system/df` response fields in
 * docs/research/02-docker-api-security.md §A.0/§A.1 — not captured from
 * a real daemon (none available in this environment).
 */
import type {
  SystemDfResponse,
  SystemInfoResponse,
  SystemPingResponse,
  SystemVersionResponse,
} from '@dwg/shared';

export const FIXTURE_SYSTEM_PING: SystemPingResponse = { apiVersion: '1.55' };

export const FIXTURE_SYSTEM_VERSION: SystemVersionResponse = {
  version: '29.7.0',
  apiVersion: '1.55',
  minApiVersion: '1.24',
  os: 'linux',
  arch: 'amd64',
  kernelVersion: '6.8.0-generic',
};

export const FIXTURE_SYSTEM_INFO: SystemInfoResponse = {
  containers: 3,
  containersRunning: 1,
  containersPaused: 0,
  containersStopped: 2,
  images: 5,
  serverVersion: '29.7.0',
  driver: 'overlay2',
  ncpu: 4,
  memTotal: 8_589_934_592,
};

export const FIXTURE_SYSTEM_DF: SystemDfResponse = {
  layersSizeBytes: 3_221_225_472,
  imagesCount: 5,
  containersCount: 3,
  volumesCount: 4,
  buildCacheBytes: 0,
};
