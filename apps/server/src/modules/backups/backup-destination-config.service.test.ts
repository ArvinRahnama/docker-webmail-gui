import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { BackupDestinationConfigRepository } from './backup-destination-config.repository.js';
import { BackupDestinationConfigService } from './backup-destination-config.service.js';

const ACTOR = { adminId: null, label: 'admin@example.com' };
const SECRET = 'super-secret-access-key';

function setUp(): { db: Database; service: BackupDestinationConfigService } {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const service = new BackupDestinationConfigService(new BackupDestinationConfigRepository(db), db);
  return { db, service };
}

function s3Update(secret?: string): Parameters<BackupDestinationConfigService['update']>[0] {
  return {
    type: 's3',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'my-bucket',
    prefix: 'backups',
    accessKeyId: 'AKIAEXAMPLE',
    ...(secret !== undefined ? { secretAccessKey: secret } : {}),
  };
}

function auditActions(db: Database, action: string): number {
  return db.all('SELECT id FROM audit_log WHERE action = ?', [action]).length;
}

describe('BackupDestinationConfigService', () => {
  it('defaults to no destination', () => {
    const { service } = setUp();
    expect(service.getStatus()).toEqual({
      type: 'none',
      configured: false,
      describe: null,
      s3: null,
    });
    expect(service.resolve()).toEqual({ type: 'none' });
  });

  it('stores an S3 config, masks the secret in status, but resolves it internally', () => {
    const { service } = setUp();
    service.update(s3Update(SECRET), ACTOR);

    const status = service.getStatus();
    expect(status).toMatchObject({
      type: 's3',
      configured: true,
      describe: 's3://my-bucket/backups',
      s3: { accessKeyId: 'AKIAEXAMPLE', secretAccessKeySet: true },
    });
    // The secret must never appear in the masked status.
    expect(JSON.stringify(status)).not.toContain(SECRET);

    // ...but resolve() (server-internal) carries it for the signer.
    const resolved = service.resolve();
    expect(resolved.type).toBe('s3');
    expect(resolved.type === 's3' && resolved.s3.secretAccessKey).toBe(SECRET);
  });

  it('keeps the stored secret when an update omits it', () => {
    const { service } = setUp();
    service.update(s3Update(SECRET), ACTOR);
    // Update other fields without re-sending the secret.
    service.update(
      { ...s3Update(), bucket: 'renamed-bucket' } as ReturnType<typeof s3Update>,
      ACTOR,
    );
    const resolved = service.resolve();
    expect(resolved.type === 's3' && resolved.s3.bucket).toBe('renamed-bucket');
    expect(resolved.type === 's3' && resolved.s3.secretAccessKey).toBe(SECRET);
  });

  it('refuses a first-time S3 config with no secret', () => {
    const { service } = setUp();
    expect(() => service.update(s3Update(), ACTOR)).toThrow(/secret access key is required/i);
  });

  it('reveals the secret only through the audited reveal path', () => {
    const { db, service } = setUp();
    service.update(s3Update(SECRET), ACTOR);
    const before = auditActions(db, 'config.reveal_secret');
    expect(service.revealSecret(ACTOR)).toEqual({ value: SECRET });
    expect(auditActions(db, 'config.reveal_secret')).toBe(before + 1);
  });

  it('audits config.apply and takes a pre-change snapshot that captures the prior secret', () => {
    const { db, service } = setUp();
    service.update(s3Update(SECRET), ACTOR); // 1 apply, snapshot of the empty prior
    service.update({ ...s3Update(), bucket: 'v2' } as ReturnType<typeof s3Update>, ACTOR); // 2nd apply

    expect(auditActions(db, 'config.apply')).toBe(2);
    // The snapshot taken before the 2nd update holds the prior config, secret included.
    const snapshots = db.all<{ config_json: string }>(
      'SELECT config_json FROM backup_destination_snapshots ORDER BY created_at',
    );
    expect(snapshots.length).toBe(2);
    expect(snapshots[1]!.config_json).toContain(SECRET);
  });

  it('switching to none clears the resolved destination', () => {
    const { service } = setUp();
    service.update(s3Update(SECRET), ACTOR);
    service.update({ type: 'none' }, ACTOR);
    expect(service.resolve()).toEqual({ type: 'none' });
    expect(service.getStatus().configured).toBe(false);
  });
});
