/**
 * Sieve script management service (FEATURE_MATRIX.md §17). List/get are
 * reads; put/activate/deactivate are mutations, each audited by the route
 * layer. Content is validated twice before it ever reaches `doveadm sieve
 * put` — size cap and the execute/pipe denylist
 * (`drivers/dms/sieve-validator.ts`) here, and Pigeonhole's own compiler
 * (a real syntax check this project does not attempt to duplicate) when
 * `doveadm sieve put` actually runs; a compile failure there is mapped to
 * `VALIDATION_FAILED`, not `UPSTREAM_UNAVAILABLE`, because it is the
 * admin's script that is wrong, not the deployment that is unreachable.
 *
 * No capability gate here — `docs/research/01-docker-mailserver.md`'s
 * Sieve section states plainly that "Sieve filters themselves are
 * file-based, not env-configured"; the only related toggle,
 * `ENABLE_MANAGESIEVE`, gates the separate ManageSieve *network protocol*
 * (port 4190) this project deliberately does not use (research doc §6:
 * "prefer `doveadm sieve put/get/list/activate` over ManageSieve"). There
 * is therefore no env var for an `UnsupportedNotice` to name — a real
 * runtime failure (e.g. the mailbox does not exist) surfaces through the
 * normal error path instead.
 */
import { DmsCommandExecutionError } from '../../drivers/dms/errors.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { validateSieveScriptContent } from '../../drivers/dms/sieve-validator.js';
import { AppError } from '../../platform/errors.js';
import type { SieveScriptDetailResponse, SieveScriptSummary } from '@dwg/shared';

export class SieveService {
  constructor(private readonly dmsDriver: DmsDriver) {}

  async list(user: string): Promise<readonly SieveScriptSummary[]> {
    return this.dmsDriver.sieveList(user);
  }

  async get(user: string, name: string): Promise<SieveScriptDetailResponse> {
    // Existence is checked via the list first, rather than calling
    // `sieveGet` on a name we have not confirmed exists and trying to
    // distinguish "not found" from some other failure by pattern-matching
    // `doveadm`'s stderr text — a distinction this project has no
    // confirmed, stable string to key on. This also gives a real
    // `NOT_FOUND` instead of the generic `UPSTREAM_UNAVAILABLE` a raw
    // exec failure would otherwise map to.
    const scripts = await this.dmsDriver.sieveList(user);
    const summary = scripts.find((script) => script.name === name);
    if (!summary) {
      throw new AppError('NOT_FOUND', `No Sieve script named "${name}" exists for ${user}.`);
    }

    const content = await this.dmsDriver.sieveGet(user, name);
    return { name, content, active: summary.active };
  }

  async put(user: string, name: string, content: string): Promise<void> {
    const validation = validateSieveScriptContent(content);
    if (!validation.ok) {
      throw new AppError('VALIDATION_FAILED', validation.reason ?? 'Invalid Sieve script.');
    }

    try {
      await this.dmsDriver.sievePut({ user, script: name, content });
    } catch (err) {
      if (err instanceof DmsCommandExecutionError) {
        throw new AppError(
          'VALIDATION_FAILED',
          err.stderr.trim().length > 0
            ? err.stderr.trim()
            : 'Dovecot rejected this script (it may not compile).',
        );
      }
      throw err;
    }
  }

  async activate(user: string, name: string): Promise<void> {
    const scripts = await this.dmsDriver.sieveList(user);
    if (!scripts.some((script) => script.name === name)) {
      throw new AppError('NOT_FOUND', `No Sieve script named "${name}" exists for ${user}.`);
    }
    await this.dmsDriver.sieveActivate({ user, script: name });
  }

  async deactivate(user: string): Promise<void> {
    await this.dmsDriver.sieveDeactivate({ user });
  }
}
