/**
 * STARTTLS negotiation over an already-open plaintext socket
 * (`docs/research/03-mail-stack-components.md` §9: "you must speak the
 * plaintext protocol first... then call `tls.connect({ socket:
 * thatExistingPlainSocket, ... })`"). Node's `tls` module has no
 * protocol-aware STARTTLS helper, so this is the small per-protocol
 * handshake the research doc flagged as needed.
 *
 * Written against a minimal {@link NegotiableSocket} interface — not
 * `net.Socket` directly — so the negotiation logic itself (read the
 * greeting, send the right command, check the response code) is fully
 * unit-testable against a hand-built fake with no real TCP connection,
 * same "port" discipline as `drivers/dms/exec-port.ts` and
 * `drivers/dns/types.ts`. `real-tls-source.ts` is the only place that
 * hands this a real `net.Socket`.
 */
import { EventEmitter } from 'node:events';

export interface NegotiableSocket {
  write(data: string): boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  off(event: 'data', listener: (chunk: Buffer) => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
}

/** Matches Node's real `net.Socket`, which is an `EventEmitter` with exactly this method surface — used by `real-tls-source.ts` to pass one straight through. */
export type NodeLikeSocket = NegotiableSocket & EventEmitter;

const DEFAULT_LINE_TIMEOUT_MS = 5000;

/**
 * Buffers incoming bytes and resolves line-by-line, in order — one
 * persistent listener rather than repeatedly attaching/detaching one per
 * read, so a server response spanning multiple lines in a single TCP
 * chunk (common for multi-line SMTP EHLO replies) is never partially
 * dropped the way a naive "attach a listener, take the first line,
 * discard the rest of the chunk" approach would.
 */
export class LineReader {
  private buffer = '';
  private readonly pending: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private closeError: Error | null = null;

  constructor(private readonly socket: NegotiableSocket) {
    socket.on('data', this.onData);
    socket.once('error', this.onSocketError);
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8');
    this.flush();
  };

  private flush(): void {
    while (this.pending.length > 0) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.pending.shift();
      waiter?.resolve(line);
    }
  }

  private readonly onSocketError = (err: Error): void => {
    this.closeError = err;
    while (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter?.reject(err);
    }
  };

  readLine(timeoutMs: number = DEFAULT_LINE_TIMEOUT_MS): Promise<string> {
    if (this.closeError) return Promise.reject(this.closeError);

    return new Promise((resolve, reject) => {
      const entry = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(entry);
        if (index !== -1) this.pending.splice(index, 1);
        reject(new Error('Timed out waiting for a response.'));
      }, timeoutMs);
      this.pending.push(entry);
      this.flush();
    });
  }

  /** Detaches this reader's listeners — call once negotiation is done and the socket is about to be handed to `tls.connect`. */
  dispose(): void {
    this.socket.off('data', this.onData);
  }
}

/** Reads SMTP's multi-line reply convention: continuation lines have `-` as the 4th character (`250-STARTTLS`), the final line has a space (`250 OK`). */
async function readSmtpReply(reader: LineReader, timeoutMs: number): Promise<string[]> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.readLine(timeoutMs);
    lines.push(line);
    if (line.length < 4 || line[3] !== '-') return lines;
  }
}

function replyCode(line: string): string {
  return line.slice(0, 3);
}

export interface NegotiateOptions {
  readonly timeoutMs?: number;
}

/**
 * SMTP/submission STARTTLS (RFC 3207): read the greeting, `EHLO`, then
 * `STARTTLS`. A `220` reply to `STARTTLS` means the server is ready for
 * the TLS handshake to begin immediately on this same socket.
 */
export async function negotiateSmtpStartTls(
  socket: NegotiableSocket,
  options: NegotiateOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LINE_TIMEOUT_MS;
  const reader = new LineReader(socket);
  try {
    const greeting = await readSmtpReply(reader, timeoutMs);
    if (replyCode(greeting[greeting.length - 1] ?? '') !== '220') {
      throw new Error(`Server greeting was not 220: ${greeting[greeting.length - 1] ?? ''}`);
    }

    socket.write('EHLO dwg-tls-check\r\n');
    await readSmtpReply(reader, timeoutMs);

    socket.write('STARTTLS\r\n');
    const response = await readSmtpReply(reader, timeoutMs);
    const last = response[response.length - 1] ?? '';
    if (replyCode(last) !== '220') {
      throw new Error(`Server did not accept STARTTLS: ${last}`);
    }
  } finally {
    reader.dispose();
  }
}

/** IMAP STARTTLS (RFC 3501 §6.2.1): read the greeting, then a tagged `STARTTLS` command must get a tagged `OK` back. */
export async function negotiateImapStartTls(
  socket: NegotiableSocket,
  options: NegotiateOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LINE_TIMEOUT_MS;
  const reader = new LineReader(socket);
  try {
    const greeting = await reader.readLine(timeoutMs);
    if (!/^\*\s+OK/i.test(greeting)) {
      throw new Error(`Unexpected IMAP greeting: ${greeting}`);
    }

    socket.write('a1 STARTTLS\r\n');
    const response = await reader.readLine(timeoutMs);
    if (!/^a1\s+OK/i.test(response)) {
      throw new Error(`Server did not accept STARTTLS: ${response}`);
    }
  } finally {
    reader.dispose();
  }
}

/** POP3 STLS (RFC 2595): read the greeting, then `STLS` must get a `+OK`. */
export async function negotiatePop3StartTls(
  socket: NegotiableSocket,
  options: NegotiateOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LINE_TIMEOUT_MS;
  const reader = new LineReader(socket);
  try {
    const greeting = await reader.readLine(timeoutMs);
    if (!/^\+OK/i.test(greeting)) {
      throw new Error(`Unexpected POP3 greeting: ${greeting}`);
    }

    socket.write('STLS\r\n');
    const response = await reader.readLine(timeoutMs);
    if (!/^\+OK/i.test(response)) {
      throw new Error(`Server did not accept STLS: ${response}`);
    }
  } finally {
    reader.dispose();
  }
}
