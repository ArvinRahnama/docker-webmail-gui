/**
 * The E2E harness's own in-process fake S3 — the twin of
 * `apps/server/src/modules/backups/destinations/fake-s3-server.ts`, duplicated
 * here because the Playwright typecheck project (`tsconfig.e2e.json`) references
 * only `packages/shared` and cannot import `apps/server` internals.
 *
 * It runs inside the Playwright worker on loopback; the real Fastify server
 * under test (a separate `node dist/index.js` process) reaches it over
 * 127.0.0.1 once a spec points the destination config at its port. This is the
 * sanctioned stand-in for S3 — the milestone forbids a real S3/FTP in tests,
 * and no spec ever talks to a real object store or the VPS.
 *
 * Speaks just enough of the S3 REST surface (ListObjectsV2, GET/PUT/DELETE
 * object, and the multipart dance) to exercise the real `S3Destination` end to
 * end. Auth is not validated here — the server signs every request with SigV4
 * regardless; the unit-level `fake-s3-server.ts` is where "every request is
 * signed" is asserted.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

interface Multipart {
  key: string;
  parts: Map<number, Buffer>;
}

export interface FakeS3 {
  server: Server;
  port: number;
  readonly objects: Map<string, Buffer>;
  readonly multipart: Map<string, Multipart>;
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
  let uploadCounter = 0;

  const state: FakeS3 = {
    server: undefined as unknown as Server,
    port: 0,
    objects: new Map<string, Buffer>(),
    multipart: new Map<string, Multipart>(),
    close: () => Promise.resolve(),
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const withoutLeadingSlash = url.pathname.replace(/^\//, '');
    const firstSlash = withoutLeadingSlash.indexOf('/');
    const key = firstSlash === -1 ? '' : withoutLeadingSlash.slice(firstSlash + 1);
    const q = url.searchParams;

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
        state.objects.set(key, Buffer.concat(ordered));
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
        state.objects.set(key, body);
        res.writeHead(200);
        res.end();
      });
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

    if (req.method === 'DELETE') {
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
