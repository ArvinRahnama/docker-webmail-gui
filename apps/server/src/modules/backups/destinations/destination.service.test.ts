import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DestinationService, type ResolvedDestination } from './destination.service.js';
import { startFakeS3, type FakeS3 } from './fake-s3-server.js';

let fake: FakeS3;

beforeEach(async () => {
  fake = await startFakeS3();
});
afterEach(async () => {
  await fake.close();
});

function s3Settings(): ResolvedDestination {
  return {
    type: 's3',
    s3: {
      endpoint: `http://127.0.0.1:${fake.port}`,
      region: 'us-east-1',
      bucket: 'backups-bucket',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      prefix: 'backups',
    },
  };
}

describe('DestinationService', () => {
  it('reports no destination when settings are none', async () => {
    const service = new DestinationService({ resolve: () => ({ type: 'none' }) });
    expect(service.current()).toBeNull();
    expect(service.isConfigured()).toBe(false);
    await expect(service.testConnection()).rejects.toThrow(/No remote destination/);
  });

  it('builds an S3 destination from settings and tests the connection', async () => {
    const service = new DestinationService({ resolve: s3Settings });
    const destination = service.current();
    expect(destination?.type).toBe('s3');
    expect(service.isConfigured()).toBe(true);
    await expect(service.testConnection()).resolves.toBeUndefined();
  });
});
