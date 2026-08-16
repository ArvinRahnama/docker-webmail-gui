/**
 * Domains service (FEATURE_MATRIX.md §2; UX_ARCHITECTURE.md §6.3). Purely
 * a read projection over `DmsDriver.listDomains()` (itself a pure
 * derivation, `drivers/dms/domains.ts`) plus the mailboxes/aliases that
 * belong to one domain for the detail view. **There is no create, update
 * or delete method on this class** — see the module's own doc comment in
 * `domains.routes.ts` for why that is not an oversight.
 */
import type { DomainDetailResponse, DomainSummary } from '@dwg/shared';
import type { DmsDriver } from '../../drivers/dms/index.js';
import {
  restrictionSetsFrom,
  toAliasSummaryDto,
  toDomainSummaryDto,
  toMailboxSummaryDto,
} from './mail-mappers.js';

export class DomainsService {
  constructor(private readonly driver: DmsDriver) {}

  async list(): Promise<DomainSummary[]> {
    const domains = await this.driver.listDomains();
    return domains.map(toDomainSummaryDto);
  }

  /**
   * `undefined` when no derived domain matches — the caller (routes)
   * turns that into `NOT_FOUND`. Matching is case-insensitive
   * (`deriveDomains` already lowercases every domain it derives).
   */
  async getDetail(domainParam: string): Promise<DomainDetailResponse | undefined> {
    const normalized = domainParam.trim().toLowerCase();

    const [domains, accountsResult, aliasesResult, sendAccess, receiveAccess, quotasResult] =
      await Promise.all([
        this.driver.listDomains(),
        this.driver.listMailboxes(),
        this.driver.listAliases(),
        this.driver.getRestrictedAddresses('send'),
        this.driver.getRestrictedAddresses('receive'),
        this.driver.listQuotas(),
      ]);

    const found = domains.find((domain) => domain.domain === normalized);
    if (!found) return undefined;

    const localDomains = new Set(domains.map((domain) => domain.domain));
    const quotaByEmail = new Map(quotasResult.entries.map((quota) => [quota.email, quota.quota]));
    const restriction = restrictionSetsFrom(sendAccess.entries, receiveAccess.entries);

    const mailboxes = accountsResult.entries
      .filter((account) => account.domain === normalized)
      .map((account) => toMailboxSummaryDto(account, quotaByEmail, restriction));

    const aliases = aliasesResult.entries
      .filter((alias) => alias.domain === normalized)
      .map((alias) => toAliasSummaryDto(alias, localDomains));

    return { domain: toDomainSummaryDto(found), mailboxes, aliases };
  }
}
