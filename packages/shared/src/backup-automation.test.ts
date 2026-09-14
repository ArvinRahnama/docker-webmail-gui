import { describe, expect, it } from 'vitest';
import {
  BackupDestinationUpdateSchema,
  DEFAULT_S3_REGION,
  normalizeS3Endpoint,
} from './backup-automation.js';

const S3_BASE = {
  type: 's3',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'bucket',
  prefix: 'backups',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'example-secret',
} as const;

/** `path -> message` for every issue, so a test reads as "which field, what wording". */
function issuesOf(input: unknown): Record<string, string> {
  const result = BackupDestinationUpdateSchema.safeParse(input);
  if (result.success) return {};
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  );
}

describe('normalizeS3Endpoint', () => {
  it('assumes https:// for a bare host and keeps an explicit scheme', () => {
    expect(normalizeS3Endpoint('bucket.provider.example')).toBe('https://bucket.provider.example');
    expect(normalizeS3Endpoint('minio.local:9000')).toBe('https://minio.local:9000');
    expect(normalizeS3Endpoint('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
  });

  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeS3Endpoint('  https://s3.example.com///  ')).toBe('https://s3.example.com');
  });
});

describe('BackupDestinationUpdateSchema — S3', () => {
  it('normalises a bare-host endpoint, trims every field and defaults a blank region', () => {
    const parsed = BackupDestinationUpdateSchema.parse({
      ...S3_BASE,
      endpoint: ' bucket.provider.example/ ',
      region: '   ',
      bucket: ' Mixed-Case-Bucket ',
      prefix: ' backups ',
      accessKeyId: ' AKIAEXAMPLE ',
      secretAccessKey: ' example-secret\n',
    });
    expect(parsed).toEqual({
      type: 's3',
      endpoint: 'https://bucket.provider.example',
      region: DEFAULT_S3_REGION,
      bucket: 'Mixed-Case-Bucket',
      prefix: 'backups',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
    });
  });

  it('defaults an omitted region and keeps a provider code like "auto"', () => {
    const { region: _omitted, ...withoutRegion } = S3_BASE;
    expect(BackupDestinationUpdateSchema.parse(withoutRegion)).toMatchObject({
      region: DEFAULT_S3_REGION,
    });
    expect(BackupDestinationUpdateSchema.parse({ ...S3_BASE, region: 'auto' })).toMatchObject({
      region: 'auto',
    });
  });

  it('is idempotent — re-parsing normalised output (the server does) changes nothing', () => {
    const once = BackupDestinationUpdateSchema.parse({ ...S3_BASE, endpoint: 'host.example' });
    expect(BackupDestinationUpdateSchema.parse(once)).toEqual(once);
  });

  it('refuses a region display name with spaces, naming the field and the fix', () => {
    const issues = issuesOf({ ...S3_BASE, region: 'Tehran 3' });
    expect(Object.keys(issues)).toEqual(['region']);
    expect(issues['region']).toMatch(/region code/);
    expect(issues['region']).toMatch(/blank/);
  });

  it('refuses a non-http(s) scheme and an unparseable host', () => {
    expect(issuesOf({ ...S3_BASE, endpoint: 'ftp://files.example.com' })['endpoint']).toMatch(
      /http\(s\)/,
    );
    expect(issuesOf({ ...S3_BASE, endpoint: 'not a host' })['endpoint']).toMatch(/http\(s\)/);
  });

  it('gives each required field its own message', () => {
    const issues = issuesOf({ ...S3_BASE, endpoint: ' ', bucket: '', accessKeyId: '  ' });
    expect(issues).toEqual({
      endpoint: 'Enter the endpoint, e.g. s3.example.com.',
      bucket: 'Enter the bucket name.',
      accessKeyId: 'Enter the access key ID.',
    });
  });

  it('refuses spaces or slashes in the bucket name but not upper case', () => {
    expect(issuesOf({ ...S3_BASE, bucket: 'my bucket' })['bucket']).toMatch(/spaces or slashes/);
    expect(issuesOf({ ...S3_BASE, bucket: 'a/b' })['bucket']).toMatch(/spaces or slashes/);
    expect(issuesOf({ ...S3_BASE, bucket: 'Romak-Website' })).toEqual({});
    expect(issuesOf({ ...S3_BASE, bucket: 'my.bucket_01' })).toEqual({});
  });

  it('refuses bucket names that would re-target a path-style URL (? # %, dot-only)', () => {
    for (const bucket of ['a#b', 'a?b', 'a%2Fb', 'a\\b']) {
      expect(issuesOf({ ...S3_BASE, bucket })).toEqual({
        bucket: 'Bucket name may contain only letters, digits, . _ and - (no spaces or slashes).',
      });
    }
    for (const bucket of ['.', '..', '...']) {
      expect(issuesOf({ ...S3_BASE, bucket })).toEqual({
        bucket: 'Bucket name cannot be only dots.',
      });
    }
  });

  it('refuses credentials, a query or a fragment in the endpoint, naming the problem', () => {
    expect(
      issuesOf({ ...S3_BASE, endpoint: 'https://AKIAEXAMPLE:secret@s3.example.com' })['endpoint'],
    ).toMatch(/user name or password/);
    expect(issuesOf({ ...S3_BASE, endpoint: 'user@s3.example.com' })['endpoint']).toMatch(
      /user name or password/,
    );
    expect(issuesOf({ ...S3_BASE, endpoint: 'https://s3.example.com/?x=1' })['endpoint']).toMatch(
      /query string/,
    );
    expect(issuesOf({ ...S3_BASE, endpoint: 's3.example.com#frag' })['endpoint']).toMatch(
      /fragment/,
    );
    // A path is still allowed (e.g. an S3 API behind a reverse-proxy path).
    expect(issuesOf({ ...S3_BASE, endpoint: 'https://s3.example.com/minio' })).toEqual({});
  });

  it('refuses a mistyped scheme instead of treating "http" as the host', () => {
    for (const endpoint of [
      'http:/s3.example.com',
      'http//s3.example.com',
      'https:s3.example.com',
    ]) {
      expect(issuesOf({ ...S3_BASE, endpoint })['endpoint']).toMatch(/scheme looks mistyped/);
    }
  });

  it('keeps the stored secret when it is omitted, but refuses a whitespace-only one', () => {
    const { secretAccessKey: _omitted, ...withoutSecret } = S3_BASE;
    expect(BackupDestinationUpdateSchema.parse(withoutSecret)).not.toHaveProperty(
      'secretAccessKey',
    );
    expect(issuesOf({ ...S3_BASE, secretAccessKey: '   ' })['secretAccessKey']).toMatch(/blank/);
  });
});

describe('BackupDestinationUpdateSchema — FTP', () => {
  const FTP_BASE = {
    type: 'ftp',
    host: 'ftp.example.com',
    port: 21,
    path: 'backups',
    user: 'backup-user',
    secure: true,
    password: 'pw',
  } as const;

  it('trims host, path and user but leaves the password exactly as typed', () => {
    const parsed = BackupDestinationUpdateSchema.parse({
      ...FTP_BASE,
      host: ' ftp.example.com ',
      path: ' backups ',
      user: ' backup-user ',
      password: ' spaced pw ',
    });
    expect(parsed).toEqual({ ...FTP_BASE, password: ' spaced pw ' });
  });

  it('refuses a blank host or user with a field-specific message', () => {
    expect(issuesOf({ ...FTP_BASE, host: '  ', user: '' })).toEqual({
      host: 'Enter the FTP host.',
      user: 'Enter the username.',
    });
  });
});
