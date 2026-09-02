/**
 * Thin adapter over `basic-ftp` (M13 — FTP destination groundwork). This is
 * the one module that imports the FTP client library; the `FtpDestination`
 * built on it in the next chunk talks only to this seam, mirroring how
 * `S3Destination` owns its undici/SigV4 details behind `sigv4.ts`.
 *
 * `basic-ftp` was chosen as the smallest maintained pure-JS FTP client: it has
 * **zero runtime dependencies**, ships its own TypeScript types, is MIT, and
 * supports FTPS (explicit TLS) and REST-resume uploads — the two things the
 * destination needs beyond the basics.
 *
 * Runs in the server tier: plain FTP(S) from the app to a remote store, no
 * broker operation and no Docker socket. The password lives only inside the
 * `AccessOptions` handed to `basic-ftp`; this module never logs it.
 */
import { Client, type AccessOptions } from 'basic-ftp';

export interface FtpConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** FTPS over explicit TLS when true. */
  readonly secure: boolean;
}

/**
 * Opens a connected `basic-ftp` client for a config. The caller owns closing
 * it (`client.close()`), so a failed transfer never leaks a socket.
 */
export async function connectFtp(config: FtpConnectionConfig): Promise<Client> {
  const client = new Client();
  const access: AccessOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    secure: config.secure,
  };
  await client.access(access);
  return client;
}
