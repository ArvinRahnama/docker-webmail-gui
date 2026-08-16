import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BROKER_OPS_PATH, BROKER_SECRET_HEADER } from '@dwg/shared';
import { BrokerRequestError, RealBrokerClient } from './real-broker-client.js';

const TEST_SECRET = 'test-secret-value-at-least-32-chars-long';

interface StubRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

type StubHandler = (req: StubRequest, res: ServerResponse) => void;

/**
 * A minimal `node:http` stand-in for the broker — not the broker's own
 * Fastify app (apps/server must not depend on apps/broker; they are
 * separate deployables sharing only `@dwg/shared` — ARCHITECTURE.md §4).
 * This only needs to speak the same wire contract `RealBrokerClient`
 * expects, so the client's own request-building and response-validation
 * logic is exercised end to end.
 */
async function startStubBroker(
  handler: StubHandler,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      handler({ method: req.method, url: req.url, headers: req.headers, body }, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('RealBrokerClient — request shape', () => {
  it('POSTs to BROKER_OPS_PATH with the secret header, JSON content-type, and the operation in the body', async () => {
    let seen: StubRequest | undefined;
    const stub = await startStubBroker((req, res) => {
      seen = req;
      sendJson(res, 200, { apiVersion: '1.55' });
    });

    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });
    await client.systemPing();

    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe(BROKER_OPS_PATH);
    expect(seen?.headers[BROKER_SECRET_HEADER]).toBe(TEST_SECRET);
    expect(seen?.headers['content-type']).toContain('application/json');
    expect(seen?.body).toEqual({ operation: 'system.ping' });

    await stub.close();
  });

  it('sends only the params actually provided, never a container id (there is no field to send one in)', async () => {
    let seen: StubRequest | undefined;
    const stub = await startStubBroker((req, res) => {
      seen = req;
      sendJson(res, 200, { containers: [] });
    });

    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });
    await client.containerList({ all: true });

    expect(seen?.body).toEqual({ operation: 'container.list', all: true });
    await stub.close();
  });

  it('containerInspect/containerStart carry no target-identifying field at all', async () => {
    let seen: StubRequest | undefined;
    const stub = await startStubBroker((req, res) => {
      seen = req;
      sendJson(res, 200, { ok: true });
    });

    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });
    await client.containerStart();

    expect(seen?.body).toEqual({ operation: 'container.start' });
    await stub.close();
  });
});

describe('RealBrokerClient — response validation', () => {
  it('parses and returns a well-formed response', async () => {
    const stub = await startStubBroker((_req, res) => {
      sendJson(res, 200, {
        containers: [
          {
            id: 'abc',
            names: ['mailserver'],
            image: 'img',
            state: 'running',
            status: 'Up',
            labels: {},
            createdAt: 1_700_000_000,
          },
        ],
      });
    });

    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });
    const containers = await client.containerList();

    expect(containers).toHaveLength(1);
    expect(containers[0]?.id).toBe('abc');
    await stub.close();
  });

  it('throws rather than trusting a response that does not match the expected schema', async () => {
    const stub = await startStubBroker((_req, res) => {
      sendJson(res, 200, { totallyWrongShape: true });
    });

    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });
    await expect(client.containerList()).rejects.toThrow();
    await stub.close();
  });
});

describe('RealBrokerClient — error handling', () => {
  it('throws BrokerRequestError with the status code and the broker-provided message on a non-2xx response', async () => {
    const stub = await startStubBroker((_req, res) => {
      sendJson(res, 401, {
        error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid broker secret.' },
      });
    });

    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });
    const error = await client.systemPing().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BrokerRequestError);
    expect((error as BrokerRequestError).statusCode).toBe(401);
    expect((error as BrokerRequestError).message).toBe('Missing or invalid broker secret.');
    await stub.close();
  });

  it('falls back to a generic message, without throwing itself, when the error body is not the expected shape', async () => {
    const stub = await startStubBroker((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });
    const error = await client.systemPing().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BrokerRequestError);
    expect((error as BrokerRequestError).statusCode).toBe(500);
    expect((error as BrokerRequestError).message.length).toBeGreaterThan(0);
    await stub.close();
  });
});

describe('RealBrokerClient — lifecycle acknowledgements', () => {
  it('containerStart/containerStop/containerRestart resolve void on a successful ack, and never throw for a well-formed one', async () => {
    const stub = await startStubBroker((_req, res) => sendJson(res, 200, { ok: true }));
    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });

    await expect(client.containerStart()).resolves.toBeUndefined();
    await expect(client.containerStop()).resolves.toBeUndefined();
    await expect(client.containerRestart()).resolves.toBeUndefined();

    await stub.close();
  });
});

describe('RealBrokerClient — logs', () => {
  it('returns the already-decoded lines array from the broker', async () => {
    const stub = await startStubBroker((_req, res) =>
      sendJson(res, 200, { lines: [{ stream: 'stdout', data: 'hello' }] }),
    );
    const client = new RealBrokerClient({ baseUrl: stub.baseUrl, sharedSecret: TEST_SECRET });

    const lines = await client.containerLogs({ tail: 10 });
    expect(lines).toEqual([{ stream: 'stdout', data: 'hello' }]);
    await stub.close();
  });
});
