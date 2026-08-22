/**
 * SECURITY.md Part 5 check 1: "Injection payloads against every command
 * builder."
 *
 * `drivers/dms/commands.test.ts` already runs `INJECTION_PAYLOADS` against
 * most of `commands.ts`'s builders — that coverage is real and is left
 * exactly as it is (M12's own working agreement: do not rewrite what is
 * already proven). What was missing was a way to know the two files
 * together are *exhaustive* rather than merely thorough: nothing forced
 * every `build*` export to appear somewhere, so a builder added after
 * that file was last touched — or one it simply never got around to —
 * could carry an unvalidated string parameter with no test noticing.
 *
 * `COVERAGE` below is a manifest, one entry per `build*` export in
 * `commands.ts`. The first test in this file diffs its keys against the
 * module's actual exports: adding a new builder without adding a matching
 * entry here fails the suite immediately, and removing a builder without
 * removing its entry does too — the manifest cannot silently drift out of
 * sync with the module the way a doc comment's claim of exhaustiveness
 * could (and, elsewhere in this milestone, did — see
 * `command-palette.route-coverage.test.ts`'s doc comment for the sibling
 * finding this same shape of bug produced in the frontend).
 *
 * Two real gaps this file closes, found by building that manifest and
 * having every entry demand a justification:
 *
 *  - `buildAliasDeleteCommand`'s `recipient` parameter had no injection
 *    coverage at all — `commands.test.ts` only ever fed a payload as the
 *    `alias` half of the pair.
 *  - The five `doveadm sieve …` / `doveadm quota get` builders
 *    (`buildDoveadmQuotaGetCommand`, `buildSieveListCommand`,
 *    `buildSieveGetCommand`, `buildSievePutCommand`,
 *    `buildSieveActivateCommand`, `buildSieveDeactivateCommand`) had no
 *    injection coverage anywhere — M8/M9 additions that landed after
 *    `commands.test.ts`'s sweep was last extended.
 */
import { describe, expect, it } from 'vitest';
import * as commands from './commands.js';
import type { CommandResult } from './commands.js';

const INJECTION_PAYLOADS = ['; rm -rf /', '$(id)', '`id`', 'a\nb', '-leadinghyphen'] as const;

/** Identical contract to `commands.test.ts`'s own helper of the same name — kept in sync deliberately, not imported, so this file's assertions do not depend on that file's internals staying stable. */
function expectRejectedOrInert(result: CommandResult, payload: string) {
  if (!result.ok) {
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    return;
  }
  const argv = result.command.argv;
  expect(argv.filter((element) => element === payload)).toHaveLength(1);
  for (const element of argv) {
    expect(element).not.toBe('sh');
    expect(element).not.toBe('bash');
    expect(element).not.toBe('-c');
  }
}

type CoverageEntry =
  | {
      /** Every string parameter is swept with `INJECTION_PAYLOADS` in `commands.test.ts` already. */
      readonly status: 'tested-in-commands-test';
    }
  | {
      /** Every string parameter is swept with `INJECTION_PAYLOADS` below, in this file. */
      readonly status: 'tested-here';
    }
  | {
      /** Both of the above, for different parameters of the same builder — see `note`. */
      readonly status: 'tested-in-both';
      readonly note: string;
    }
  | {
      /** Takes no parameters, or only non-string/closed-enum parameters with no client-reachable string to inject. */
      readonly status: 'no-injectable-parameter';
      readonly note: string;
    };

const COVERAGE: Record<string, CoverageEntry> = {
  buildEmailAddCommand: { status: 'tested-in-commands-test' },
  buildEmailUpdateCommand: { status: 'tested-in-commands-test' },
  buildEmailDeleteCommand: { status: 'tested-in-commands-test' },
  buildEmailRestrictCommand: { status: 'tested-in-commands-test' },
  buildEmailListCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
  buildAliasAddCommand: { status: 'tested-in-commands-test' },
  buildAliasDeleteCommand: {
    status: 'tested-in-both',
    note: 'alias tested in commands.test.ts; recipient tested here',
  },
  buildAliasListCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
  buildQuotaSetCommand: { status: 'tested-in-commands-test' },
  buildQuotaDeleteCommand: { status: 'tested-in-commands-test' },
  buildDoveadmQuotaGetCommand: { status: 'tested-here' },
  buildConfigDkimCommand: { status: 'tested-in-commands-test' },
  buildFail2banListCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
  buildFail2banBanCommand: { status: 'tested-in-commands-test' },
  buildFail2banUnbanCommand: { status: 'tested-in-commands-test' },
  buildFail2banLogCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
  buildFail2banStatusCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
  buildClamdCommand: {
    status: 'no-injectable-parameter',
    note:
      "ClamdVerb is a closed 3-value TS union ('PING'|'VERSION'|'STATS'); every call site " +
      '(real-dms-driver.ts) passes a literal, never a value that traced back to client input',
  },
  buildFreshclamCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
  buildClamavLogTailCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
  buildSieveListCommand: { status: 'tested-here' },
  buildSieveGetCommand: { status: 'tested-here' },
  buildSievePutCommand: { status: 'tested-here' },
  buildSieveActivateCommand: { status: 'tested-here' },
  buildSieveDeactivateCommand: { status: 'tested-here' },
  buildPostqueueJsonCommand: { status: 'no-injectable-parameter', note: 'takes no parameters' },
};

describe('command-injection coverage manifest is exhaustive over commands.ts', () => {
  it('every build* export has exactly one COVERAGE entry, and every COVERAGE entry names a real export', () => {
    const exported = Object.keys(commands).filter((name) => name.startsWith('build'));
    expect(new Set(exported)).toEqual(new Set(Object.keys(COVERAGE)));
  });
});

describe('buildAliasDeleteCommand — recipient injection (the gap: alias alone was covered)', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`rejects/inerts "${payload}" as the recipient`, () => {
      expectRejectedOrInert(
        commands.buildAliasDeleteCommand({ alias: 'ok@example.com', recipient: payload }),
        payload,
      );
    });
  }
});

describe('buildDoveadmQuotaGetCommand injection', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`rejects/inerts "${payload}" as the email`, () => {
      expectRejectedOrInert(commands.buildDoveadmQuotaGetCommand({ email: payload }), payload);
    });
  }
});

describe('sieve command builders — injection', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`buildSieveListCommand rejects/inerts "${payload}" as the user`, () => {
      expectRejectedOrInert(commands.buildSieveListCommand({ user: payload }), payload);
    });

    it(`buildSieveGetCommand rejects/inerts "${payload}" as the user`, () => {
      expectRejectedOrInert(
        commands.buildSieveGetCommand({ user: payload, script: 'ok-script' }),
        payload,
      );
    });

    it(`buildSieveGetCommand rejects/inerts "${payload}" as the script name`, () => {
      expectRejectedOrInert(
        commands.buildSieveGetCommand({ user: 'admin@example.com', script: payload }),
        payload,
      );
    });

    it(`buildSievePutCommand rejects/inerts "${payload}" as the user`, () => {
      expectRejectedOrInert(
        commands.buildSievePutCommand({ user: payload, script: 'ok-script', content: 'keep;' }),
        payload,
      );
    });

    it(`buildSievePutCommand rejects/inerts "${payload}" as the script name`, () => {
      expectRejectedOrInert(
        commands.buildSievePutCommand({
          user: 'admin@example.com',
          script: payload,
          content: 'keep;',
        }),
        payload,
      );
    });

    it(`buildSieveActivateCommand rejects/inerts "${payload}" as the user`, () => {
      expectRejectedOrInert(
        commands.buildSieveActivateCommand({ user: payload, script: 'ok-script' }),
        payload,
      );
    });

    it(`buildSieveActivateCommand rejects/inerts "${payload}" as the script name`, () => {
      expectRejectedOrInert(
        commands.buildSieveActivateCommand({ user: 'admin@example.com', script: payload }),
        payload,
      );
    });

    it(`buildSieveDeactivateCommand rejects/inerts "${payload}" as the user`, () => {
      expectRejectedOrInert(commands.buildSieveDeactivateCommand({ user: payload }), payload);
    });
  }

  // `buildSievePutCommand`'s `content` is never an argv element — it goes
  // to stdin, the same protocol a password uses (commands.ts's own header
  // comment) — so there is nothing to sweep for shell-metacharacter argv
  // injection there. What *is* worth pinning is that an arbitrary payload
  // in `content` never leaks into argv regardless.
  it('buildSievePutCommand never puts `content` into argv, however it is spelled', () => {
    for (const payload of INJECTION_PAYLOADS) {
      const result = commands.buildSievePutCommand({
        user: 'admin@example.com',
        script: 'ok-script',
        content: payload,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.command.argv).not.toContain(payload);
        expect(result.command.stdin).toBe(payload);
      }
    }
  });
});
