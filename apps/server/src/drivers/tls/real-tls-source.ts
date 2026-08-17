/**
 * Real {@link TlsCertificateSourcePort}: connects out from the Node
 * server process itself (`docs/research/03-mail-stack-components.md`
 * §9 — "this needs raw TCP, so it must run in the Node backend"), fetches
 * whatever certificate the target mail port presents, and hands back its
 * raw DER bytes for `cert-parser.ts` to parse. Never reads or transmits
 * a private key — there is no code path here that could, since neither
 * `tls.connect` call below is ever given a `key`/`cert` option of our
 * own; this only ever receives the *peer's* certificate.
 *
 * `rejectUnauthorized: false` on both connect calls is deliberate and
 * safe here: this is a **diagnostic reader**, not a client verifying a
 * connection it is about to trust for delivering mail. We want the
 * certificate the server presents *regardless* of whether it is
 * self-signed or expired, precisely so `cert-parser.ts` and
 * `tls.service.ts` can report that fact to the admin — refusing the
 * connection on a bad cert would make the "your cert is expired/self-signed"
 * diagnostic impossible to ever show.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { negotiateImapStartTls, negotiatePop3StartTls, negotiateSmtpStartTls } from './starttls.js';
import type {
  StartTlsProtocol,
  TlsCertificateFetchResult,
  TlsCertificateSourcePort,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 8000;

function fetchFromTlsSocket(
  connect: () => import('node:tls').TLSSocket,
  timeoutMs: number,
): Promise<TlsCertificateFetchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TlsCertificateFetchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tlsSocket.destroy();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ reachable: false, der: null, error: 'Connection timed out.' }),
      timeoutMs,
    );
    const tlsSocket = connect();

    tlsSocket.once('secureConnect', () => {
      const cert = tlsSocket.getPeerCertificate(false);
      const der = cert && cert.raw ? cert.raw : null;
      finish({
        reachable: true,
        der,
        error: der ? null : 'The server completed a TLS handshake but presented no certificate.',
      });
    });
    tlsSocket.once('error', (err: Error) =>
      finish({ reachable: false, der: null, error: err.message }),
    );
  });
}

function connectPlain(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Connection timed out.'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class RealTlsCertificateSource implements TlsCertificateSourcePort {
  async fetchImplicitTlsCertificate(
    host: string,
    port: number,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<TlsCertificateFetchResult> {
    try {
      return await fetchFromTlsSocket(
        () => tlsConnect({ host, port, servername: host, rejectUnauthorized: false }),
        timeoutMs,
      );
    } catch (err) {
      return {
        reachable: false,
        der: null,
        error: err instanceof Error ? err.message : 'Connection failed.',
      };
    }
  }

  async fetchStartTlsCertificate(
    host: string,
    port: number,
    protocol: StartTlsProtocol,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<TlsCertificateFetchResult> {
    let plainSocket: Socket;
    try {
      plainSocket = await connectPlain(host, port, timeoutMs);
    } catch (err) {
      return {
        reachable: false,
        der: null,
        error: err instanceof Error ? err.message : 'Connection failed.',
      };
    }

    try {
      const negotiate =
        protocol === 'smtp'
          ? negotiateSmtpStartTls
          : protocol === 'imap'
            ? negotiateImapStartTls
            : negotiatePop3StartTls;
      await negotiate(plainSocket, { timeoutMs });
    } catch (err) {
      plainSocket.destroy();
      return {
        reachable: false,
        der: null,
        error: err instanceof Error ? err.message : 'STARTTLS negotiation failed.',
      };
    }

    return fetchFromTlsSocket(
      () => tlsConnect({ socket: plainSocket, servername: host, rejectUnauthorized: false }),
      timeoutMs,
    );
  }
}

export function createRealTlsCertificateSource(): TlsCertificateSourcePort {
  return new RealTlsCertificateSource();
}
