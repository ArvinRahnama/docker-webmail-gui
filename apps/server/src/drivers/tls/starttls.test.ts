import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  LineReader,
  negotiateImapStartTls,
  negotiatePop3StartTls,
  negotiateSmtpStartTls,
  type NegotiableSocket,
} from './starttls.js';

/**
 * A fully in-memory `NegotiableSocket` double — no real TCP connection
 * anywhere in this test file. Composes an `EventEmitter` (rather than
 * extending it) so `off`'s signature can match `NegotiableSocket`'s exact
 * `void`-returning contract instead of `EventEmitter#off`'s
 * `this`-returning one.
 */
class FakeSocket implements NegotiableSocket {
  private readonly emitter = new EventEmitter();
  readonly written: string[] = [];

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  on(event: 'data', listener: (chunk: Buffer) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: 'data', listener: (chunk: Buffer) => void): void {
    this.emitter.off(event, listener);
  }

  once(event: 'error', listener: (err: Error) => void): void {
    this.emitter.once(event, listener);
  }

  emit(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args);
  }

  emitLine(line: string): void {
    this.emit('data', Buffer.from(`${line}\r\n`));
  }

  emitRaw(text: string): void {
    this.emit('data', Buffer.from(text));
  }
}

describe('LineReader', () => {
  it('resolves a line that arrives in one chunk', async () => {
    const socket = new FakeSocket();
    const reader = new LineReader(socket);
    const promise = reader.readLine();
    socket.emitLine('220 hello');
    await expect(promise).resolves.toBe('220 hello');
  });

  it('resolves a line that arrives split across multiple chunks', async () => {
    const socket = new FakeSocket();
    const reader = new LineReader(socket);
    const promise = reader.readLine();
    socket.emitRaw('220 par');
    socket.emitRaw('tial\r\n');
    await expect(promise).resolves.toBe('220 partial');
  });

  it('does not drop a second line that arrived in the same chunk as the first', async () => {
    const socket = new FakeSocket();
    const reader = new LineReader(socket);
    const first = reader.readLine();
    socket.emitRaw('250-first\r\n250 second\r\n');
    await expect(first).resolves.toBe('250-first');
    await expect(reader.readLine()).resolves.toBe('250 second');
  });

  it('rejects on socket error', async () => {
    const socket = new FakeSocket();
    const reader = new LineReader(socket);
    const promise = reader.readLine();
    socket.emit('error', new Error('boom'));
    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects after the configured timeout with no data', async () => {
    const socket = new FakeSocket();
    const reader = new LineReader(socket);
    await expect(reader.readLine(10)).rejects.toThrow(/timed out/i);
  });
});

describe('negotiateSmtpStartTls', () => {
  it('sends EHLO then STARTTLS and resolves on a 220 reply', async () => {
    const socket = new FakeSocket();
    const promise = negotiateSmtpStartTls(socket, { timeoutMs: 1000 });

    socket.emitLine('220 mail.example.com ESMTP');
    await Promise.resolve();
    socket.emitLine('250-mail.example.com');
    socket.emitLine('250-STARTTLS');
    socket.emitLine('250 8BITMIME');
    await Promise.resolve();
    socket.emitLine('220 2.0.0 Ready to start TLS');

    await expect(promise).resolves.toBeUndefined();
    expect(socket.written).toEqual(['EHLO dwg-tls-check\r\n', 'STARTTLS\r\n']);
  });

  it('rejects when the server refuses STARTTLS', async () => {
    const socket = new FakeSocket();
    const promise = negotiateSmtpStartTls(socket, { timeoutMs: 1000 });

    socket.emitLine('220 mail.example.com ESMTP');
    await Promise.resolve();
    socket.emitLine('250 mail.example.com');
    await Promise.resolve();
    socket.emitLine('502 Command not implemented');

    await expect(promise).rejects.toThrow(/did not accept STARTTLS/i);
  });

  it('rejects on a non-220 greeting', async () => {
    const socket = new FakeSocket();
    const promise = negotiateSmtpStartTls(socket, { timeoutMs: 1000 });
    socket.emitLine('421 Service not available');
    await expect(promise).rejects.toThrow(/greeting/i);
  });
});

describe('negotiateImapStartTls', () => {
  it('sends a tagged STARTTLS and resolves on a tagged OK', async () => {
    const socket = new FakeSocket();
    const promise = negotiateImapStartTls(socket, { timeoutMs: 1000 });

    socket.emitLine('* OK IMAP4rev1 Service Ready');
    await Promise.resolve();
    socket.emitLine('a1 OK Begin TLS negotiation now');

    await expect(promise).resolves.toBeUndefined();
    expect(socket.written).toEqual(['a1 STARTTLS\r\n']);
  });

  it('rejects on a tagged NO/BAD response', async () => {
    const socket = new FakeSocket();
    const promise = negotiateImapStartTls(socket, { timeoutMs: 1000 });
    socket.emitLine('* OK IMAP4rev1 Service Ready');
    await Promise.resolve();
    socket.emitLine('a1 NO STARTTLS not supported');
    await expect(promise).rejects.toThrow(/did not accept STARTTLS/i);
  });
});

describe('negotiatePop3StartTls', () => {
  it('sends STLS and resolves on +OK', async () => {
    const socket = new FakeSocket();
    const promise = negotiatePop3StartTls(socket, { timeoutMs: 1000 });

    socket.emitLine('+OK POP3 server ready');
    await Promise.resolve();
    socket.emitLine('+OK Begin TLS negotiation');

    await expect(promise).resolves.toBeUndefined();
    expect(socket.written).toEqual(['STLS\r\n']);
  });

  it('rejects on -ERR', async () => {
    const socket = new FakeSocket();
    const promise = negotiatePop3StartTls(socket, { timeoutMs: 1000 });
    socket.emitLine('+OK POP3 server ready');
    await Promise.resolve();
    socket.emitLine('-ERR not supported');
    await expect(promise).rejects.toThrow(/did not accept STLS/i);
  });
});
