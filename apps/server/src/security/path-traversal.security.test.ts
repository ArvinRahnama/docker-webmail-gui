/**
 * SECURITY.md Part 5 check 2: "Path traversal against every file-touching
 * endpoint."
 *
 * This project's file-touching surfaces, enumerated from the code rather
 * than assumed, and how each is closed:
 *
 *  1. `GET /api/v1/docker/logs/file/:source` — `logs.routes.ts` validates
 *     `:source` against `LogFileSourceSchema` (a fixed two-value enum)
 *     *before* it reaches `LogsService` or the broker; the broker
 *     independently re-validates the same enum server-side
 *     (`apps/broker/src/operations.ts`'s `LOG_FILE_PATHS`, tested in
 *     `apps/broker/src/app.test.ts`'s "rejects a source outside the fixed
 *     enum, including a path-traversal attempt"). That file's own doc
 *     comment already claimed this; nothing at the HTTP layer had tested
 *     it before this file. Closed below.
 *  2. `doveadm sieve …`'s `:user`/`:name` route params
 *     (`sieve.routes.ts`) — validated by `validateAddressForArgv` /
 *     `validateSieveScriptName` (`drivers/dms/validators.ts`) via the
 *     same `commands.ts` builders `command-injection.security.test.ts`
 *     already sweeps with shell-metacharacter payloads. This file adds
 *     path-shaped payloads specifically (`../`, absolute paths, encoded
 *     separators) — a different attack shape, since Dovecot's own Sieve
 *     storage backend addresses scripts by name on disk inside the DMS
 *     container, and `validateSieveScriptName` bans `/`, `\` and `..`
 *     expressly for that reason. One route is closed a different way,
 *     worth noting rather than assuming it matches its siblings:
 *     `GET /:user/:name` (`sieve.service.ts`'s `get()`) confirms the name
 *     against an already-validated `sieveList()` result before ever
 *     calling a builder that would validate `name` itself, so a
 *     traversal payload 404s as "no such script" rather than
 *     400-ing as invalid — never reaching a builder either way, just by
 *     a different route. See that test's own comment below.
 *  3. Backups (`backups.routes.ts`) — `:id` is never joined into a
 *     filesystem path directly; every handler resolves it through
 *     `BackupsRepository.getRowById`/`getSummaryById` first (an exact-
 *     match SQL lookup, parameterised), and only a row's own
 *     server-generated `file_path` column — never the client-supplied
 *     `id` string — is ever used as a path (`backups.service.ts`).
 *     Backup ids are minted by `generateId('bkp')`
 *     (`backups.service.ts`'s `create`), never client-suppliable, so a
 *     traversal-shaped `id` can only ever miss the lookup. Verified below
 *     at the HTTP layer: every route refuses before touching disk.
 *  4. Config editor (`config.routes.ts`) — `:key`/`reveal` resolves
 *     through `findSettingDefinition`, an exact-match lookup against the
 *     fixed `SETTINGS_ALLOWLIST` array (`settings-allowlist.ts`), not a
 *     path of any kind. A traversal-shaped key simply misses the
 *     allowlist.
 *  5. DMS config-file reads (`real-dms-driver.ts`'s `execPort.readFile`)
 *     — `DmsExecPort.readFile`'s parameter type is `DmsConfigFileName`, a
 *     closed string-literal union (`exec-port.ts`); every call site in
 *     `real-dms-driver.ts` passes either a literal of that type or an
 *     index into `RESTRICT_SCOPE_FILE_NAME`, a `Record<RestrictScope,
 *     …>` the `satisfies` clause on its declaration pins to exactly two
 *     entries. No route anywhere accepts a client-supplied file name for
 *     this driver to read — `tsc --build` (part of `npm run check`) is
 *     the enforcement for this one, the same way it is for any other
 *     closed union; there is no runtime string here for a payload sweep
 *     to reach.
 *  6. The restricted console (`console.routes.ts`) — `ConsoleCommand` is
 *     a closed four-value enum mapped to a broker-owned, zero-argument
 *     argv table (`operations.ts`'s `CONSOLE_COMMAND_ARGV`); already
 *     covered by `apps/broker/src/app.test.ts`'s "rejects an attempt to
 *     pass a raw argv array instead of a symbolic command key".
 */
import { describe, expect, it } from 'vitest';
import {
  loginAs,
  authedInject,
  setUpSecurityApp,
  type SecurityHarness,
} from '../modules/security/security-test-harness.js';

/**
 * Path-shaped attack payloads — distinct from `command-injection.security
 * .test.ts`'s shell-metacharacter set, because a file-touching endpoint's
 * threat is escaping a directory, not escaping a shell. Covers a
 * Unix-style traversal, a Windows-style one, a URL-encoded traversal
 * sequence, an absolute path and an overlong-dot variant. Each is sent
 * through `encodeURIComponent` when it becomes a URL path segment below,
 * so it survives as the exact decoded string a route handler's
 * `request.params` would see — the payload must survive being a *decoded*
 * string, not merely a raw URL.
 */
const TRAVERSAL_PAYLOADS = [
  '../../../etc/passwd',
  '..\\..\\..\\etc\\passwd',
  '..%2f..%2fetc%2fpasswd',
  '/etc/passwd',
  '....//....//etc/passwd',
] as const;

async function withApp(run: (harness: SecurityHarness) => Promise<void>): Promise<void> {
  const harness = await setUpSecurityApp();
  try {
    await run(harness);
  } finally {
    await harness.app.close();
  }
}

describe('GET /api/v1/docker/logs/file/:source refuses every traversal payload', () => {
  for (const payload of TRAVERSAL_PAYLOADS) {
    it(`rejects "${payload}" as source, before any broker call`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'GET',
          url: `/api/v1/docker/logs/file/${encodeURIComponent(payload)}`,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_FAILED');
      });
    });
  }

  it('accepts the two real enum values, proving the rejection above is the enum working, not the route being broken', async () => {
    await withApp(async ({ app }) => {
      const auth = await loginAs(app);
      for (const source of ['mail', 'fail2ban']) {
        const response = await authedInject(app, auth, {
          method: 'GET',
          url: `/api/v1/docker/logs/file/${source}`,
        });
        expect(response.statusCode).toBe(200);
      }
    });
  });
});

describe('sieve routes refuse path-shaped :user and :name', () => {
  for (const payload of TRAVERSAL_PAYLOADS) {
    it(`GET /security/sieve/:user rejects "${payload}" as user`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'GET',
          url: `/api/v1/security/sieve/${encodeURIComponent(payload)}`,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_FAILED');
      });
    });

    // Not VALIDATION_FAILED here, unlike every other case in this describe
    // block — a real difference in `sieve.service.ts`'s `get()`, worth
    // recording rather than papering over. `get()` confirms the script
    // exists by checking it against an already-validated `sieveList()`
    // result *before* ever calling the builder that would validate `name`
    // itself (its own doc comment: "gives a real NOT_FOUND instead of the
    // generic UPSTREAM_UNAVAILABLE a raw exec failure would otherwise
    // map to"). A traversal-shaped name can never appear in that list —
    // every real entry came from a name `put()` already validated — so it
    // 404s as "no such script" without a validated builder ever being
    // called with it at all. Structurally at least as safe as a
    // VALIDATION_FAILED rejection (the malicious name never reaches an
    // argv builder either way), just a different reason.
    it(`GET /security/sieve/:user/:name 404s "${payload}" as the script name — never found in the (validated) list, never reaches a builder`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'GET',
          url: `/api/v1/security/sieve/admin@example.com/${encodeURIComponent(payload)}`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('NOT_FOUND');
      });
    });

    it(`PUT /security/sieve/:user/:name rejects "${payload}" as the script name before writing anything`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'PUT',
          url: `/api/v1/security/sieve/admin@example.com/${encodeURIComponent(payload)}`,
          payload: { content: 'require ["fileinto"];\nkeep;' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_FAILED');
      });
    });
  }
});

describe('backup routes never let a client-supplied id reach the filesystem', () => {
  for (const payload of TRAVERSAL_PAYLOADS) {
    it(`GET /backups/:id with "${payload}" 404s — the DB lookup, not a path join, is the gate`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'GET',
          url: `/api/v1/backups/${encodeURIComponent(payload)}`,
        });
        expect(response.statusCode).toBe(404);
        // Distinct from a generic route-miss — only backups.service.ts's
        // own NOT_FOUND produces this text, proving the request reached
        // the DB lookup rather than merely failing to match a route.
        expect(response.json().error.message).toContain('No backup with id');
      });
    });

    it(`GET /backups/:id/download with "${payload}" 404s rather than streaming anything`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'GET',
          url: `/api/v1/backups/${encodeURIComponent(payload)}/download`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.message).toContain('No backup with id');
      });
    });

    it(`DELETE /backups/:id with "${payload}" 404s rather than unlinking anything`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'DELETE',
          url: `/api/v1/backups/${encodeURIComponent(payload)}`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.message).toContain('No backup with id');
      });
    });
  }
});

describe('config settings reveal refuses a path-shaped :key — the allowlist lookup, not a path, is the gate', () => {
  for (const payload of TRAVERSAL_PAYLOADS) {
    it(`POST /config/settings/:key/reveal with "${payload}" 404s from the allowlist miss, not a route-not-found`, async () => {
      await withApp(async ({ app }) => {
        const auth = await loginAs(app);
        const response = await authedInject(app, auth, {
          method: 'POST',
          url: `/api/v1/config/settings/${encodeURIComponent(payload)}/reveal`,
        });
        expect(response.statusCode).toBe(404);
        // Distinct from Fastify's generic "That route does not exist."
        // (app.ts's setNotFoundHandler) — this message can only be
        // produced by config.service.ts's own reveal(), proving the
        // request reached real application logic rather than merely
        // failing to match a route at all (which would 404 just as
        // easily without proving anything about the allowlist).
        expect(response.json().error.message).toContain('is not an editable setting');
      });
    });
  }
});
