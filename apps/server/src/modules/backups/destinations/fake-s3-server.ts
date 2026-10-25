/**
 * An in-process fake S3 server for tests — a real `node:http` server speaking
 * just enough of the S3 REST surface (ListObjectsV2, ListObjectVersions,
 * GET/DELETE object — per version too — and the multipart dance:
 * CreateMultipartUpload / UploadPart / CompleteMultipartUpload /
 * AbortMultipartUpload / ListMultipartUploads) to
 * exercise the real `S3Destination` and the whole upload/import/restore-from-
 * remote flow end to end, all over loopback. The milestone forbids a real
 * S3/FTP in tests; this is the local fake that stands in for one.
 *
 * Not matched by vitest's `*.test.ts` glob, so it is a shared helper, never a
 * suite of its own.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

interface Multipart {
  key: string;
  parts: Map<number, Buffer>;
}

/** One stored version of a key; `body: null` is a delete marker. */
export interface FakeObjectVersion {
  readonly versionId: string;
  readonly body: Buffer | null;
}

export interface FakeS3 {
  server: Server;
  port: number;
  readonly objects: Map<string, Buffer>;
  readonly multipart: Map<string, Multipart>;
  readonly sawAuthOnEveryRequest: () => boolean;
  /** Set to a part number to make that UploadPart fail once (then it clears itself). */
  failPartOnce: number | null;
  /**
   * Mimics providers whose endpoint host *is* the bucket (`<bucket>.provider.net`):
   * a request for any other bucket gets 403 SignatureDoesNotMatch naming this one.
   */
  servedBucket: string | null;
  /**
   * Mimics a path-style provider that hosts only these buckets: a request for
   * any other gets 404 NoSuchBucket naming the bucket that was requested, as
   * AWS does.
   */
  knownBuckets: readonly string[] | null;
  /**
   * Set to make every request answer with this S3 `<Error>` until cleared.
   * `fields` adds further elements after `<Code>` (e.g. the `StringToSign` /
   * `CanonicalRequest` AWS echoes on SignatureDoesNotMatch, or `<Region>`),
   * in order, XML-escaped.
   */
  errorResponse: {
    readonly status: number;
    readonly code: string;
    readonly fields?: Readonly<Record<string, string>>;
  } | null;
  /**
   * Bucket versioning, as AWS documents it: every PUT (or completed multipart)
   * stores a new version, a plain DELETE only adds a delete marker — the key
   * vanishes from ListObjectsV2 while every version stays stored — and
   * `DELETE ?versionId=` removes one version for good. Off by default: keys
   * then live in `objects` alone and list as the single version `null`.
   */
  versioning: boolean;
  /** Every stored version per key while `versioning` is on, oldest first. `objects` mirrors the current one. */
  readonly versions: Map<string, FakeObjectVersion[]>;
  /** How `GET ?versions` answers: normally, like a provider without the API (501 NotImplemented), or denied (403). */
  versionsApi: 'ok' | 'not-implemented' | 'access-denied';
  /** ListObjectVersions page size — set low to exercise pagination. */
  versionsPageSize: number;
  /** Version ids an Object Lock protects: deleting one answers 403 AccessDenied. */
  readonly lockedVersions: Set<string>;
  close(): Promise<void>;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeS3(): Promise<FakeS3> {
  let everyRequestSigned = true;
  let uploadCounter = 0;

  const state: FakeS3 = {
    server: undefined as unknown as Server,
    port: 0,
    objects: new Map<string, Buffer>(),
    multipart: new Map<string, Multipart>(),
    sawAuthOnEveryRequest: () => everyRequestSigned,
    failPartOnce: null,
    servedBucket: null,
    knownBuckets: null,
    errorResponse: null,
    versioning: false,
    versions: new Map<string, FakeObjectVersion[]>(),
    versionsApi: 'ok',
    versionsPageSize: 1000,
    lockedVersions: new Set<string>(),
    close: () => Promise.resolve(),
  };

  let versionCounter = 0;
  const nextVersionId = (): string => {
    versionCounter += 1;
    return `v${versionCounter}`;
  };

  const putObject = (key: string, body: Buffer): void => {
    state.objects.set(key, body);
    if (!state.versioning) return;
    const list = state.versions.get(key) ?? [];
    list.push({ versionId: nextVersionId(), body });
    state.versions.set(key, list);
  };

  /** Re-derives `objects` from a key's newest remaining version. */
  const syncCurrent = (key: string): void => {
    const list = state.versions.get(key) ?? [];
    const latest = list.at(-1);
    if (latest === undefined) state.versions.delete(key);
    if (latest === undefined || latest.body === null) state.objects.delete(key);
    else state.objects.set(key, latest.body);
  };

  /** Every version under `prefix` in ListObjectVersions order: keys ascending, each key's versions newest first. */
  const listedVersions = (
    prefix: string,
  ): { key: string; versionId: string; body: Buffer | null; isLatest: boolean }[] => {
    const keys = [...new Set([...state.versions.keys(), ...state.objects.keys()])]
      .filter((key) => key.startsWith(prefix))
      .sort();
    return keys.flatMap((key) => {
      const list = state.versions.get(key);
      if (list === undefined) {
        return [{ key, versionId: 'null', body: state.objects.get(key) ?? null, isLatest: true }];
      }
      return [...list]
        .reverse()
        .map((version, index) => ({ key, ...version, isLatest: index === 0 }));
    });
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (
      typeof req.headers.authorization !== 'string' ||
      !req.headers.authorization.startsWith('AWS4-HMAC-SHA256 ') ||
      typeof req.headers['x-amz-content-sha256'] !== 'string'
    ) {
      everyRequestSigned = false;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const withoutLeadingSlash = url.pathname.replace(/^\//, '');
    const firstSlash = withoutLeadingSlash.indexOf('/');
    const key = firstSlash === -1 ? '' : withoutLeadingSlash.slice(firstSlash + 1);
    const q = url.searchParams;
    const bucket =
      firstSlash === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, firstSlash);

    if (state.errorResponse !== null) {
      res.writeHead(state.errorResponse.status, { 'content-type': 'application/xml' });
      const fields = Object.entries(state.errorResponse.fields ?? {})
        .map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`)
        .join('');
      res.end(
        `<?xml version="1.0"?><Error><Code>${xmlEscape(state.errorResponse.code)}</Code>` +
          `${fields}</Error>`,
      );
      return;
    }
    if (state.knownBuckets !== null && !state.knownBuckets.includes(bucket)) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><Error><Code>NoSuchBucket</Code>` +
          `<BucketName>${xmlEscape(bucket)}</BucketName></Error>`,
      );
      return;
    }
    if (state.servedBucket !== null && bucket !== state.servedBucket) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code>` +
          `<BucketName>${xmlEscape(state.servedBucket)}</BucketName></Error>`,
      );
      return;
    }

    if (req.method === 'GET' && q.has('versions')) {
      if (state.versionsApi !== 'ok') {
        const [status, code] =
          state.versionsApi === 'not-implemented' ? [501, 'NotImplemented'] : [403, 'AccessDenied'];
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
        return;
      }
      const all = listedVersions(q.get('prefix') ?? '');
      const keyMarker = q.get('key-marker');
      const versionIdMarker = q.get('version-id-marker');
      const start =
        keyMarker === null
          ? 0
          : all.findIndex((v) => v.key === keyMarker && v.versionId === versionIdMarker) + 1;
      const page = all.slice(start, start + state.versionsPageSize);
      const truncated = start + page.length < all.length;
      const last = page.at(-1);
      const body = page
        .map((v) =>
          v.body === null
            ? `<DeleteMarker><Key>${xmlEscape(v.key)}</Key><VersionId>${v.versionId}</VersionId>` +
              `<IsLatest>${v.isLatest}</IsLatest></DeleteMarker>`
            : `<Version><Key>${xmlEscape(v.key)}</Key><VersionId>${v.versionId}</VersionId>` +
              `<IsLatest>${v.isLatest}</IsLatest><Size>${v.body.length}</Size></Version>`,
        )
        .join('');
      const markers =
        truncated && last !== undefined
          ? `<NextKeyMarker>${xmlEscape(last.key)}</NextKeyMarker>` +
            `<NextVersionIdMarker>${last.versionId}</NextVersionIdMarker>`
          : '';
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><ListVersionsResult><IsTruncated>${truncated}</IsTruncated>` +
          `${markers}${body}</ListVersionsResult>`,
      );
      return;
    }

    if (req.method === 'GET' && q.has('uploads')) {
      const uploads = [...state.multipart.entries()]
        .map(
          ([id, mp]) =>
            `<Upload><Key>${xmlEscape(mp.key)}</Key><UploadId>${xmlEscape(id)}</UploadId></Upload>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><ListMultipartUploadsResult>${uploads}</ListMultipartUploadsResult>`,
      );
      return;
    }

    if (req.method === 'GET' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? '';
      const maxKeys = q.get('max-keys');
      const matching = [...state.objects.entries()].filter(([k]) => k.startsWith(prefix));
      const limited = maxKeys === '0' ? [] : matching;
      const contents = limited
        .map(
          ([k, body]) =>
            `<Contents><Key>${xmlEscape(k)}</Key><Size>${body.length}</Size>` +
            `<LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
      return;
    }

    if (req.method === 'POST' && q.has('uploads')) {
      uploadCounter += 1;
      const uploadId = `upload-${uploadCounter}`;
      state.multipart.set(uploadId, { key, parts: new Map() });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }

    if (req.method === 'POST' && q.has('uploadId')) {
      void readBody(req).then(() => {
        const uploadId = q.get('uploadId') ?? '';
        const mp = state.multipart.get(uploadId);
        if (mp === undefined) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0"?><Error><Code>NoSuchUpload</Code></Error>');
          return;
        }
        const ordered = [...mp.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
        putObject(key, Buffer.concat(ordered));
        state.multipart.delete(uploadId);
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          '<?xml version="1.0"?><CompleteMultipartUploadResult></CompleteMultipartUploadResult>',
        );
      });
      return;
    }

    if (req.method === 'PUT' && q.has('uploadId')) {
      void readBody(req).then((body) => {
        const partNumber = Number(q.get('partNumber'));
        if (state.failPartOnce === partNumber) {
          state.failPartOnce = null;
          res.writeHead(500, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0"?><Error><Code>InternalError</Code></Error>');
          return;
        }
        const mp = state.multipart.get(q.get('uploadId') ?? '');
        if (mp === undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
        mp.parts.set(partNumber, body);
        res.writeHead(200, { etag: `"etag-${partNumber}"` });
        res.end();
      });
      return;
    }

    if (req.method === 'DELETE' && q.has('uploadId')) {
      state.multipart.delete(q.get('uploadId') ?? '');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'PUT') {
      void readBody(req).then((body) => {
        putObject(key, body);
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (req.method === 'HEAD') {
      res.writeHead(state.objects.has(key) ? 200 : 404);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      const body = state.objects.get(key);
      if (body === undefined) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-tar' });
      res.end(body);
      return;
    }

    if (req.method === 'DELETE' && q.has('versionId')) {
      const versionId = q.get('versionId') ?? '';
      if (state.lockedVersions.has(versionId)) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>');
        return;
      }
      const list = state.versions.get(key);
      if (list === undefined) {
        if (versionId === 'null') state.objects.delete(key);
      } else {
        state.versions.set(
          key,
          list.filter((version) => version.versionId !== versionId),
        );
        syncCurrent(key);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      if (state.versioning) {
        // A plain DELETE on a versioned bucket hides the key behind a delete
        // marker; every stored version stays.
        const list = state.versions.get(key) ?? [];
        list.push({ versionId: nextVersionId(), body: null });
        state.versions.set(key, list);
      }
      state.objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  state.server = server;
  state.port = port;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
