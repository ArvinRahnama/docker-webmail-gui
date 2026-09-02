/**
 * An in-process fake FTP server for tests — the FTP twin of
 * `fake-s3-server.ts`. Speaks just enough of the RFC 959 control/data protocol
 * (passive mode only) for `basic-ftp` to drive the real `FtpDestination` end to
 * end: login, TYPE/PWD/CWD, PASV, LIST, STOR, APPE (upload resume), RETR (with
 * REST for download resume), SIZE, DELE, MKD.
 *
 * Plaintext only — no AUTH TLS — so tests connect with `secure: false`. FTPS is
 * a connection option the destination passes through to `basic-ftp`; the
 * transfer logic under test is identical either way, exactly as the S3 fake
 * validates no signature. The milestone forbids a real FTP server in tests;
 * this is the local stand-in.
 *
 * Not matched by vitest's `*.test.ts` glob, so it is a shared helper, never a
 * suite of its own.
 */
import { createServer as createTcpServer, type Server, type Socket } from 'node:net';

export interface FakeFtp {
  server: Server;
  port: number;
  /** Stored files, keyed by absolute path (e.g. `/backups/bkp_1.tar`). */
  readonly files: Map<string, Buffer>;
  close(): Promise<void>;
}

function listingLine(name: string, size: number): string {
  // A Unix `ls -l`-style line basic-ftp's default parser accepts.
  return `-rw-r--r-- 1 ftp ftp ${size} Jan 01 2026 ${name}`;
}

function resolvePath(currentDir: string, arg: string): string {
  if (arg.startsWith('/')) return arg;
  const base = currentDir.endsWith('/') ? currentDir.slice(0, -1) : currentDir;
  return `${base}/${arg}`;
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

export async function startFakeFtp(): Promise<FakeFtp> {
  const files = new Map<string, Buffer>();

  const server = createTcpServer((control: Socket) => {
    let currentDir = '/';
    let restOffset = 0;
    // The pending passive data connection: a promise that resolves with the
    // data socket once basic-ftp connects to the port announced by PASV.
    let dataSocket: Promise<Socket> | null = null;
    let dataServer: Server | null = null;

    const send = (line: string): void => {
      control.write(`${line}\r\n`);
    };

    const openPassive = (): Promise<number> =>
      new Promise((resolve) => {
        dataServer?.close();
        const ds = createTcpServer();
        dataServer = ds;
        dataSocket = new Promise<Socket>((resolveSocket) => {
          ds.once('connection', (socket) => resolveSocket(socket));
        });
        ds.listen(0, '127.0.0.1', () => {
          const address = ds.address();
          const port = typeof address === 'object' && address !== null ? address.port : 0;
          resolve(port);
        });
      });

    const receiveData = async (): Promise<Buffer> => {
      const socket = await dataSocket!;
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('end', () => resolve());
        socket.on('close', () => resolve());
      });
      return Buffer.concat(chunks);
    };

    const sendData = async (body: Buffer): Promise<void> => {
      const socket = await dataSocket!;
      await new Promise<void>((resolve) => {
        socket.end(body, () => resolve());
      });
    };

    control.setEncoding('utf8');
    control.write('220 Fake FTP ready\r\n');

    let buffer = '';
    control.on('data', (data: string) => {
      buffer += data;
      let newline = buffer.indexOf('\r\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        void handleCommand(line);
        newline = buffer.indexOf('\r\n');
      }
    });

    async function handleCommand(line: string): Promise<void> {
      const spaceIndex = line.indexOf(' ');
      const command = (spaceIndex === -1 ? line : line.slice(0, spaceIndex)).toUpperCase();
      const arg = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);

      switch (command) {
        case 'USER':
          send('331 Password required');
          return;
        case 'PASS':
          send('230 Logged in');
          return;
        case 'SYST':
          send('215 UNIX Type: L8');
          return;
        case 'FEAT':
          // No MLST -> basic-ftp uses LIST; no UTF8 -> it skips OPTS UTF8.
          control.write('211-Features:\r\n211 End\r\n');
          return;
        case 'TYPE':
        case 'STRU':
        case 'MODE':
        case 'OPTS':
        case 'NOOP':
          send('200 OK');
          return;
        case 'PWD':
          send(`257 "${currentDir}" is current directory`);
          return;
        case 'CWD':
          currentDir = resolvePath(currentDir, arg);
          send('250 OK');
          return;
        case 'MKD':
          send(`257 "${resolvePath(currentDir, arg)}" created`);
          return;
        case 'REST':
          restOffset = Number(arg) || 0;
          send(`350 Restarting at ${restOffset}`);
          return;
        case 'SIZE': {
          const path = resolvePath(currentDir, arg);
          const file = files.get(path);
          send(file === undefined ? '550 Not found' : `213 ${file.length}`);
          return;
        }
        case 'DELE': {
          const path = resolvePath(currentDir, arg);
          send(files.delete(path) ? '250 Deleted' : '550 Not found');
          return;
        }
        case 'PASV': {
          const port = await openPassive();
          const p1 = Math.floor(port / 256);
          const p2 = port % 256;
          send(`227 Entering Passive Mode (127,0,0,1,${p1},${p2})`);
          return;
        }
        case 'LIST':
        case 'NLST': {
          // Strip flags (e.g. "-a") and an optional path argument.
          const withoutFlags = arg
            .split(' ')
            .filter((token) => token.length > 0 && !token.startsWith('-'));
          const target =
            withoutFlags.length > 0 ? resolvePath(currentDir, withoutFlags[0]!) : currentDir;
          const prefix = target.endsWith('/') ? target : `${target}/`;
          const lines = [...files.entries()]
            .filter(
              ([path]) => dirnameOf(path) === (target.endsWith('/') ? target.slice(0, -1) : target),
            )
            .map(([path, body]) => listingLine(path.slice(prefix.length), body.length))
            .join('\r\n');
          send('150 Opening data connection');
          await sendData(Buffer.from(lines.length > 0 ? `${lines}\r\n` : ''));
          send('226 Transfer complete');
          return;
        }
        case 'STOR': {
          const path = resolvePath(currentDir, arg);
          send('150 Opening data connection');
          const body = await receiveData();
          files.set(path, body);
          send('226 Transfer complete');
          return;
        }
        case 'APPE': {
          const path = resolvePath(currentDir, arg);
          send('150 Opening data connection');
          const body = await receiveData();
          const existing = files.get(path) ?? Buffer.alloc(0);
          files.set(path, Buffer.concat([existing, body]));
          send('226 Transfer complete');
          return;
        }
        case 'RETR': {
          const path = resolvePath(currentDir, arg);
          const file = files.get(path);
          if (file === undefined) {
            send('550 Not found');
            restOffset = 0;
            return;
          }
          const slice = restOffset > 0 ? file.subarray(restOffset) : file;
          restOffset = 0;
          send('150 Opening data connection');
          await sendData(slice);
          send('226 Transfer complete');
          return;
        }
        case 'QUIT':
          send('221 Bye');
          control.end();
          return;
        default:
          send('502 Command not implemented');
          return;
      }
    }

    control.on('close', () => {
      dataServer?.close();
    });
    control.on('error', () => {
      // A client hanging up mid-transfer is normal in tests; never throw.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    server,
    port,
    files,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
