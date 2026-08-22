/**
 * SECURITY.md Part 5 check 4: "No Docker socket reachable from the web
 * tier." AGENT_BRIEF.md §2 states the invariant this protects: apps/server
 * holds *no socket and no Docker vocabulary* — full RCE in the web tier
 * must yield nothing beyond the broker's own allowlist, which requires
 * apps/server to have no way to reach `/var/run/docker.sock` at all, not
 * merely a policy against using one.
 *
 * The strongest gate for this is `eslint.config.js`'s apps/server-only
 * `no-restricted-imports` ban on `dockerode`/`docker-modem` — a build-time
 * failure the moment such an import is typed, applying to every file
 * unconditionally, including ones a test suite might never import. This
 * file is the runtime backstop: it re-derives the same property a
 * different way (reading the dependency manifest and the source tree
 * directly, and inspecting the actual loaded config), so the invariant
 * does not rest on the lint config alone staying correct.
 *
 * A real (M12) finding this file's first describe block would have
 * caught: apps/server/src/platform/config.ts declared a `DOCKER_SOCKET_PATH`
 * / `dockerSocketPath` config field — copied, it appears, from
 * apps/broker's own (legitimate) config module — that no code in
 * apps/server ever read. Nothing opened a socket with it, so it was not
 * an active vulnerability, but an unused field shaped exactly like the
 * one thing this tier must never hold is one accidental wire-up away from
 * becoming one, and its presence was inconsistent with "no Docker
 * vocabulary" taken literally. Removed; this test pins its absence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../platform/config.js';

const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER_SRC = `${SERVER_ROOT}/src`;

/** Package names that would give apps/server a way to speak to the Docker Engine API or its socket directly. Substring-based on purpose: a scoped or renamed fork (`@foo/dockerode`) must be caught too, not just the exact literal. */
const DOCKER_CLIENT_PACKAGE_PATTERN = /docker/i;

function readServerPackageJson(): {
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
} {
  const raw = readFileSync(`${SERVER_ROOT}/package.json`, 'utf8');
  return JSON.parse(raw) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
}

/** This file's own path — excluded from the scan below, since its doc comments and patterns necessarily *name* the very strings it is looking for. */
const SELF_PATH = fileURLToPath(import.meta.url);

/** Every `.ts`/`.tsx` file under apps/server/src, recursively, except this file itself. */
function listServerSourceFiles(): string[] {
  const entries = readdirSync(SERVER_SRC, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    if (path === SELF_PATH) continue;
    files.push(path);
  }
  return files;
}

describe('apps/server declares no dependency capable of reaching a Docker socket', () => {
  it('has neither "dockerode" nor "docker-modem" (or a look-alike) in dependencies or devDependencies', () => {
    const pkg = readServerPackageJson();
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const suspicious = Object.keys(allDeps).filter((name) =>
      DOCKER_CLIENT_PACKAGE_PATTERN.test(name),
    );
    expect(suspicious).toEqual([]);
  });
});

describe('apps/server source tree contains no Docker-socket-reaching code', () => {
  const files = listServerSourceFiles();

  it('scanned at least the modules this test relies on existing (sanity check on the walker itself)', () => {
    // Guards against the recursive walker silently returning an empty
    // list (e.g. a future Node change to `readdirSync`'s `recursive`
    // option) and every assertion below passing vacuously.
    expect(files.length).toBeGreaterThan(50);
  });

  it('never references the Docker Engine socket path, in code or as a string literal', () => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('docker.sock'));
    expect(offenders).toEqual([]);
  });

  it('never imports dockerode or docker-modem', () => {
    const importPattern =
      /from\s+['"](dockerode|docker-modem)['"]|require\(\s*['"](dockerode|docker-modem)['"]\s*\)/;
    const offenders = files.filter((file) => importPattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('never opens a raw Unix domain socket (the shape a hand-rolled Docker API client would take)', () => {
    // `net.connect`/`net.createConnection` with a `path`-shaped option, or
    // `http.request`'s own `socketPath` option (how `dockerode` itself
    // talks to Docker without a client library) — either would be a
    // Docker-socket-equivalent capability even without importing
    // `dockerode` by name.
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('socketPath'));
    expect(offenders).toEqual([]);
  });
});

describe('apps/server config carries no Docker socket field', () => {
  it('loadConfig() returns nothing shaped like a Docker socket path, at the top level or one level nested', () => {
    const config = loadConfig({}) as unknown as Record<string, unknown>;
    const socketLikeKeyPattern = /docker.*sock/i;

    const topLevelOffenders = Object.keys(config).filter((key) => socketLikeKeyPattern.test(key));
    expect(topLevelOffenders).toEqual([]);

    const nestedOffenders: string[] = [];
    for (const [key, value] of Object.entries(config)) {
      if (value === null || typeof value !== 'object') continue;
      for (const nestedKey of Object.keys(value as Record<string, unknown>)) {
        if (socketLikeKeyPattern.test(nestedKey)) nestedOffenders.push(`${key}.${nestedKey}`);
      }
    }
    expect(nestedOffenders).toEqual([]);
  });

  it('ignores a DOCKER_SOCKET_PATH environment variable if one is set — apps/server has no schema field to receive it', () => {
    const config = loadConfig({ DOCKER_SOCKET_PATH: '/var/run/docker.sock' }) as unknown as Record<
      string,
      unknown
    >;
    const serialised = JSON.stringify(config);
    expect(serialised.includes('docker.sock')).toBe(false);
  });
});
