/**
 * Aliases service (FEATURE_MATRIX.md §4, §5 — one mechanism for aliases
 * and forwarding). `update()` implements "editing = delete + re-add ...
 * performed atomically server-side and presented as a single edit" by
 * diffing the requested recipient set against the current one and
 * issuing exactly the `addAlias`/`deleteAlias` calls needed.
 *
 * **Loop and self-reference detection** (FEATURE_MATRIX.md §4's security
 * note): before `create`/`update` ever calls the driver, {@link
 * detectsAliasLoop} walks the *proposed* recipient set through the
 * existing alias graph and refuses if it would ever resolve back to the
 * alias being written. A direct self-reference (`alias === recipient`)
 * is simply the zero-hop case of the same walk, so there is no separate
 * check for it.
 */
import type { AliasSummary, AliasType } from '@dwg/shared';
import type { DmsDriver } from '../../drivers/dms/index.js';
import type { PostfixVirtualEntry } from '../../drivers/dms/parsers/postfix-virtual.js';
import { AppError } from '../../platform/errors.js';
import { assertLocalAccountManagementSupported } from './capability-guards.js';
import { toAliasSummaryDto } from './mail-mappers.js';

/** See `mailboxes.service.ts`'s `MailboxListQuery` comment on why every field is explicitly `| undefined`. */
export interface AliasListQuery {
  readonly domain?: string | undefined;
  readonly search?: string | undefined;
  readonly type?: AliasType | undefined;
}

export interface AliasListResult {
  readonly aliases: AliasSummary[];
  readonly unparseableLines: number;
}

/**
 * `true` if starting from `candidateRecipients` and repeatedly following
 * any recipient that is itself a known alias address ever reaches
 * `aliasAddress` again. `aliasMap` keys are lower-cased addresses;
 * `visited` bounds the walk even against an alias graph that already
 * contains an unrelated cycle.
 */
export function detectsAliasLoop(
  aliasAddress: string,
  candidateRecipients: readonly string[],
  aliasMap: ReadonlyMap<string, readonly string[]>,
): boolean {
  const target = aliasAddress.toLowerCase();
  const visited = new Set<string>();
  const stack = [...candidateRecipients];

  while (stack.length > 0) {
    // Non-null: length-guarded by the while condition above.
    const current = stack.pop()!.toLowerCase();
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const next = aliasMap.get(current);
    if (next) stack.push(...next);
  }

  return false;
}

function toAliasMap(entries: readonly PostfixVirtualEntry[]): Map<string, readonly string[]> {
  return new Map(entries.map((entry) => [entry.address.toLowerCase(), entry.recipients]));
}

export class AliasesService {
  constructor(private readonly driver: DmsDriver) {}

  private async loadEntries(): Promise<PostfixVirtualEntry[]> {
    const result = await this.driver.listAliases();
    return [...result.entries];
  }

  async list(query: AliasListQuery): Promise<AliasListResult> {
    const [aliasesResult, domains] = await Promise.all([
      this.driver.listAliases(),
      this.driver.listDomains(),
    ]);
    const localDomains = new Set(domains.map((domain) => domain.domain));
    let aliases = aliasesResult.entries.map((entry) => toAliasSummaryDto(entry, localDomains));

    if (query.domain) {
      const domain = query.domain.toLowerCase();
      aliases = aliases.filter((alias) => alias.domain === domain);
    }
    if (query.type) {
      aliases = aliases.filter((alias) => alias.type === query.type);
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      aliases = aliases.filter(
        (alias) =>
          alias.address.toLowerCase().includes(needle) ||
          alias.recipients.some((recipient) => recipient.toLowerCase().includes(needle)),
      );
    }

    return { aliases, unparseableLines: aliasesResult.issues.length };
  }

  async getByAddress(address: string): Promise<AliasSummary | undefined> {
    const [entries, domains] = await Promise.all([this.loadEntries(), this.driver.listDomains()]);
    const localDomains = new Set(domains.map((domain) => domain.domain));
    const needle = address.toLowerCase();
    const found = entries.find((entry) => entry.address.toLowerCase() === needle);
    return found ? toAliasSummaryDto(found, localDomains) : undefined;
  }

  async create(alias: string, recipients: readonly string[]): Promise<AliasSummary> {
    await assertLocalAccountManagementSupported(this.driver);

    const entries = await this.loadEntries();
    const aliasMap = toAliasMap(entries);
    if (detectsAliasLoop(alias, recipients, aliasMap)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Adding this alias would create a loop: one of its recipients eventually forwards back to ${alias}.`,
      );
    }

    for (const recipient of recipients) {
      await this.driver.addAlias({ alias, recipient });
    }

    const created = await this.getByAddress(alias);
    if (!created)
      throw new AppError('INTERNAL', 'The alias was created but could not be read back.');
    return created;
  }

  async update(address: string, recipients: readonly string[]): Promise<AliasSummary> {
    await assertLocalAccountManagementSupported(this.driver);

    const entries = await this.loadEntries();
    const existing = entries.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    if (!existing) throw new AppError('NOT_FOUND', `No alias exists for ${address}.`);

    const aliasMap = toAliasMap(entries);
    // Exclude the alias's own current entry from the loop walk's starting
    // graph — otherwise a no-op update (recipients unchanged) would
    // "detect" the alias's own existing edge back to itself only if it
    // were already a self-reference, which is exactly the case this
    // check exists to catch; every *other* alias's edges still apply.
    if (detectsAliasLoop(existing.address, recipients, aliasMap)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Updating this alias would create a loop: one of its recipients eventually forwards back to ${existing.address}.`,
      );
    }

    const desired = new Set(recipients);
    const current = new Set(existing.recipients);
    const toAdd = [...desired].filter((recipient) => !current.has(recipient));
    const toRemove = [...current].filter((recipient) => !desired.has(recipient));

    // Add before remove: for a straight swap (replace recipient A with B
    // on a single-recipient alias) this guarantees the address is never
    // briefly recipient-less mid-edit, even though DMS has no transaction
    // spanning "delete + re-add" (FEATURE_MATRIX.md §4) — each argv call
    // is independent.
    for (const recipient of toAdd) {
      await this.driver.addAlias({ alias: existing.address, recipient });
    }
    for (const recipient of toRemove) {
      await this.driver.deleteAlias({ alias: existing.address, recipient });
    }

    const updated = await this.getByAddress(existing.address);
    if (!updated) throw new AppError('NOT_FOUND', `Alias ${existing.address} no longer exists.`);
    return updated;
  }

  async remove(address: string): Promise<AliasSummary> {
    await assertLocalAccountManagementSupported(this.driver);

    const entries = await this.loadEntries();
    const existing = entries.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    if (!existing) throw new AppError('NOT_FOUND', `No alias exists for ${address}.`);

    for (const recipient of existing.recipients) {
      await this.driver.deleteAlias({ alias: existing.address, recipient });
    }

    const localDomains = new Set((await this.driver.listDomains()).map((domain) => domain.domain));
    return toAliasSummaryDto(existing, localDomains);
  }
}
