/**
 * Autoresponder service (FEATURE_MATRIX.md §18). Built entirely on top of
 * {@link SieveService}'s own primitives — the autoresponder *is* a Sieve
 * script, stored under the reserved name
 * `drivers/dms/autoresponder-sieve.ts` exports
 * (`AUTORESPONDER_SCRIPT_NAME`), generated server-side from structured
 * input so the admin never hand-writes Sieve (FEATURE_MATRIX.md §18).
 *
 * **There is no separate database table for autoresponder state.** The
 * generated script's own machine-readable header is the round-trip
 * source of truth for redisplaying subject/message/dates
 * (`autoresponder-sieve.ts`'s module comment), and "enabled" is simply
 * "is this the mailbox's *active* Sieve script right now" — a real,
 * already-true fact `sieveList` reports, not a shadow flag that could
 * drift from it.
 *
 * A real Sieve constraint worth stating plainly: Dovecot runs **one**
 * active script per mailbox. Enabling the autoresponder makes it that
 * one script, which deactivates whatever the admin separately manages
 * through the general Sieve page. This is not a limitation this project
 * introduces — it is how Pigeonhole activation works — so it is surfaced
 * honestly (in the API's `enabled` semantics and the UI copy) rather than
 * papered over.
 */
import {
  AUTORESPONDER_SCRIPT_NAME,
  generateAutoresponderSieve,
  parseAutoresponderSieve,
} from '../../drivers/dms/autoresponder-sieve.js';
import { DmsCommandExecutionError } from '../../drivers/dms/errors.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { validateSieveScriptContent } from '../../drivers/dms/sieve-validator.js';
import { AppError } from '../../platform/errors.js';
import type { AutoresponderStatus, UpdateAutoresponderRequest } from '@dwg/shared';

const EMPTY_STATUS: Omit<AutoresponderStatus, 'enabled' | 'unrecognisedContent'> = {
  subject: null,
  message: null,
  startDate: null,
  endDate: null,
};

export class AutoresponderService {
  constructor(private readonly dmsDriver: DmsDriver) {}

  async getStatus(user: string): Promise<AutoresponderStatus> {
    const scripts = await this.dmsDriver.sieveList(user);
    const summary = scripts.find((script) => script.name === AUTORESPONDER_SCRIPT_NAME);
    if (!summary) {
      return { enabled: false, unrecognisedContent: false, ...EMPTY_STATUS };
    }

    const content = await this.dmsDriver.sieveGet(user, AUTORESPONDER_SCRIPT_NAME);
    const parsed = parseAutoresponderSieve(content);
    if (!parsed) {
      // A script exists under our reserved name but was not written by
      // this generator (most likely hand-edited via the general Sieve
      // editor). `enabled` still reflects real activation state — that is
      // independent of whether the content parsed — but the fields are
      // never a guessed partial read (`sieve.ts`'s schema doc comment).
      return { enabled: summary.active, unrecognisedContent: true, ...EMPTY_STATUS };
    }

    return { enabled: summary.active, unrecognisedContent: false, ...parsed };
  }

  async update(user: string, input: UpdateAutoresponderRequest): Promise<AutoresponderStatus> {
    const script = generateAutoresponderSieve(input);

    // Defense in depth: run the generated script through the exact same
    // content validator every hand-managed Sieve script goes through
    // (`sieve-validator.ts`). This should always pass — the generator
    // controls the whole template and never invokes execute/pipe — but
    // the guarantee stays structural rather than "trust the generator."
    const validation = validateSieveScriptContent(script);
    if (!validation.ok) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Generated autoresponder script failed validation: ${validation.reason ?? 'unknown reason'}`,
      );
    }

    try {
      await this.dmsDriver.sievePut({ user, name: AUTORESPONDER_SCRIPT_NAME, content: script });
    } catch (err) {
      if (err instanceof DmsCommandExecutionError) {
        throw new AppError(
          'VALIDATION_FAILED',
          err.stderr.trim().length > 0
            ? err.stderr.trim()
            : 'Dovecot rejected the generated script.',
        );
      }
      throw err;
    }

    if (input.enabled) {
      await this.dmsDriver.sieveActivate({ user, name: AUTORESPONDER_SCRIPT_NAME });
    } else {
      // Only deactivate if the autoresponder itself is the currently
      // active script — never blind-deactivate, which could silently
      // disable an unrelated custom filter the admin manages separately.
      const scripts = await this.dmsDriver.sieveList(user);
      const summary = scripts.find((script) => script.name === AUTORESPONDER_SCRIPT_NAME);
      if (summary?.active) {
        await this.dmsDriver.sieveDeactivate({ user });
      }
    }

    return this.getStatus(user);
  }
}
