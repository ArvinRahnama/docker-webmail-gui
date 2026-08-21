/**
 * Server-Sent Events helper (ARCHITECTURE.md §8: "Server-Sent Events for
 * container state, log tailing, job progress, health changes and
 * notifications... chosen over WebSocket because every stream here is
 * server->client"). M10 is the first module to actually open one of these
 * connections (job progress) — this file is deliberately small and
 * transport-only: it knows how to open an SSE response and write
 * `event:`/`data:` frames, nothing about jobs, so a later milestone's
 * container-state or notification stream can reuse it unchanged.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

/** How often a keepalive comment line is written so intermediary proxies (and browsers) never treat an idle-but-alive stream as dead. */
const HEARTBEAT_INTERVAL_MS = 20_000;

export interface SseStream {
  /** Writes one SSE event. `data` is JSON-serialised — every event this app sends is structured, never a raw string line. */
  send: (event: string, data: unknown) => void;
  /** True once the underlying connection has closed (client navigated away, network drop) — handlers should stop pushing events and unsubscribe once this flips. */
  readonly closed: boolean;
}

/**
 * Takes over `reply`'s raw response for a long-lived `text/event-stream`
 * connection. Calls `reply.hijack()` so Fastify's own lifecycle never
 * tries to send a second response on top of this one (per Fastify 5's
 * documented escape hatch for exactly this case). Returns a handle the
 * caller uses to push events; automatically stops the heartbeat and marks
 * the stream closed when the client disconnects.
 */
export function beginSseStream(request: FastifyRequest, reply: FastifyReply): SseStream {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disables response buffering on nginx-fronted deployments, which
    // would otherwise hold the first several KB of a slow trickle of
    // events before flushing anything to the client.
    'x-accel-buffering': 'no',
  });

  const state = { closed: false };

  const heartbeat = setInterval(() => {
    if (state.closed) return;
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const stop = (): void => {
    if (state.closed) return;
    state.closed = true;
    clearInterval(heartbeat);
  };
  request.raw.on('close', stop);
  res.on('error', stop);

  return {
    get closed() {
      return state.closed;
    },
    send(event, data) {
      if (state.closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}
