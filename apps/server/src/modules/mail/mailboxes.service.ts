/**
 * Mailboxes service (FEATURE_MATRIX.md §3). Every mutating method calls
 * {@link assertLocalAccountManagementSupported} or
 * {@link assertQuotasSupported} first — before touching the driver at
 * all — so a capability-gated call fails with `CAPABILITY_UNSUPPORTED`
 * rather than a confusing driver-level error (or, worse, a write that
 * "succeeds" against a file DMS never reads under the active
 * `ACCOUNT_PROVISIONER`).
 */
import type {
  AliasSummary,
  BulkMailboxResultItem,
  MailDataChoice,
  MailboxDetailResponse,
  MailboxListResponse,
  MailboxRestrictScope,
  MailboxSummary,
} from '@dwg/shared';
import { parseQuotaToBytes, type DmsDriver } from '../../drivers/dms/index.js';
import { AppError } from '../../platform/errors.js';
import {
  assertLocalAccountManagementSupported,
  assertQuotasSupported,
} from './capability-guards.js';
import {
  restrictionSetsFrom,
  toAliasSummaryDto,
  toMailboxSummaryDto,
  toMailboxUsageDto,
} from './mail-mappers.js';

// Every field explicitly admits `| undefined` (not a bare optional) so
// this interface accepts a zod-parsed query object as-is —
// `exactOptionalPropertyTypes` treats "key absent" and "key present with
// value undefined" as different things, and a zod `.optional()` field
// produces the latter (see `unsupported-notice.tsx`'s identical comment
// on the web side for the same rule).
export interface MailboxListQuery {
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
  readonly domain?: string | undefined;
  readonly search?: string | undefined;
  readonly sortBy?: 'email' | 'domain' | 'quota' | undefined;
  readonly sortDir?: 'asc' | 'desc' | undefined;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

/**
 * Numeric, not lexical: comparing the raw strings would rank `"500M"`
 * before `"50M"` (`'0' < 'M'`), which is backwards. `null` (unlimited)
 * sorts as the largest possible value, both ascending and descending
 * being driven by the same comparator (list()'s final `sortDir ===
 * 'desc'` negation) — "no limit" is, in a real sense, the biggest quota
 * a mailbox can have.
 */
function quotaSortValue(quota: string | null): number {
  if (quota === null) return Number.POSITIVE_INFINITY;
  return parseQuotaToBytes(quota) ?? Number.POSITIVE_INFINITY;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MailboxesService {
  constructor(private readonly driver: DmsDriver) {}

  private async loadAll(): Promise<{ mailboxes: MailboxSummary[]; unparseableLines: number }> {
    const [accountsResult, quotasResult, sendAccess, receiveAccess] = await Promise.all([
      this.driver.listMailboxes(),
      this.driver.listQuotas(),
      this.driver.getRestrictedAddresses('send'),
      this.driver.getRestrictedAddresses('receive'),
    ]);
    const quotaByEmail = new Map(quotasResult.entries.map((quota) => [quota.email, quota.quota]));
    const restriction = restrictionSetsFrom(sendAccess.entries, receiveAccess.entries);
    const mailboxes = accountsResult.entries.map((account) =>
      toMailboxSummaryDto(account, quotaByEmail, restriction),
    );
    return { mailboxes, unparseableLines: accountsResult.issues.length };
  }

  async list(query: MailboxListQuery): Promise<MailboxListResponse> {
    const { mailboxes, unparseableLines } = await this.loadAll();

    let filtered = mailboxes;
    if (query.domain) {
      const domain = query.domain.toLowerCase();
      filtered = filtered.filter((mailbox) => mailbox.domain === domain);
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = filtered.filter((mailbox) => mailbox.email.toLowerCase().includes(needle));
    }

    const sortBy = query.sortBy ?? 'email';
    const sortDir = query.sortDir ?? 'asc';
    const sorted = [...filtered].sort((a, b) => {
      const cmp =
        sortBy === 'quota'
          ? quotaSortValue(a.quota) - quotaSortValue(b.quota)
          : a[sortBy].localeCompare(b[sortBy]);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const start = (page - 1) * pageSize;

    return {
      mailboxes: sorted.slice(start, start + pageSize),
      page,
      pageSize,
      total: sorted.length,
      unparseableLines,
    };
  }

  async getByEmail(email: string): Promise<MailboxSummary | undefined> {
    const { mailboxes } = await this.loadAll();
    const needle = email.toLowerCase();
    return mailboxes.find((mailbox) => mailbox.email.toLowerCase() === needle);
  }

  private async dependentAliasesFor(email: string): Promise<AliasSummary[]> {
    const [aliasesResult, domains] = await Promise.all([
      this.driver.listAliases(),
      this.driver.listDomains(),
    ]);
    const localDomains = new Set(domains.map((domain) => domain.domain));
    return aliasesResult.entries
      .filter((alias) => alias.recipients.includes(email))
      .map((alias) => toAliasSummaryDto(alias, localDomains));
  }

  async getDetail(email: string): Promise<MailboxDetailResponse | undefined> {
    const mailbox = await this.getByEmail(email);
    if (!mailbox) return undefined;

    const capabilities = await this.driver.getCapabilities();
    const usage = capabilities.quotas.supported
      ? toMailboxUsageDto(await this.driver.getMailboxUsage(mailbox.email))
      : null;
    const dependentAliases = await this.dependentAliasesFor(mailbox.email);

    return { mailbox, usage, dependentAliases };
  }

  async create(email: string, password: string): Promise<MailboxSummary> {
    await assertLocalAccountManagementSupported(this.driver);
    await this.driver.addMailbox({ email, password });
    const created = await this.getByEmail(email);
    if (!created) {
      throw new AppError('INTERNAL', 'The mailbox was created but could not be read back.');
    }
    return created;
  }

  private async requireExisting(email: string): Promise<MailboxSummary> {
    const existing = await this.getByEmail(email);
    if (!existing) throw new AppError('NOT_FOUND', `No mailbox exists for ${email}.`);
    return existing;
  }

  async changePassword(email: string, password: string): Promise<void> {
    await assertLocalAccountManagementSupported(this.driver);
    const existing = await this.requireExisting(email);
    await this.driver.updateMailboxPassword({ email: existing.email, password });
  }

  async restrict(
    email: string,
    scope: MailboxRestrictScope,
    restricted: boolean,
  ): Promise<MailboxSummary> {
    await assertLocalAccountManagementSupported(this.driver);
    const existing = await this.requireExisting(email);
    await this.driver.restrictMailbox({
      action: restricted ? 'add' : 'del',
      scope,
      email: existing.email,
    });
    return (await this.getByEmail(existing.email)) ?? existing;
  }

  async setQuota(email: string, quota: string): Promise<MailboxSummary> {
    await assertQuotasSupported(this.driver);
    const existing = await this.requireExisting(email);
    await this.driver.setQuota({ email: existing.email, quota });
    return (await this.getByEmail(existing.email)) ?? existing;
  }

  async clearQuota(email: string): Promise<MailboxSummary> {
    await assertQuotasSupported(this.driver);
    const existing = await this.requireExisting(email);
    await this.driver.deleteQuota({ email: existing.email });
    return (await this.getByEmail(existing.email)) ?? existing;
  }

  /** `mailData` is required — see `@dwg/shared`'s `MailDataChoiceSchema` doc comment; there is no overload that omits it. */
  async remove(
    email: string,
    mailData: MailDataChoice,
  ): Promise<{ mailbox: MailboxSummary; dependentAliases: AliasSummary[] }> {
    await assertLocalAccountManagementSupported(this.driver);
    const existing = await this.requireExisting(email);
    const dependentAliases = await this.dependentAliasesFor(existing.email);
    await this.driver.deleteMailbox({ emails: [existing.email], mailData });
    return { mailbox: existing, dependentAliases };
  }

  async bulkRestrict(
    addresses: readonly string[],
    scope: MailboxRestrictScope,
    restricted: boolean,
  ): Promise<BulkMailboxResultItem[]> {
    await assertLocalAccountManagementSupported(this.driver);
    const results: BulkMailboxResultItem[] = [];
    for (const email of addresses) {
      try {
        await this.driver.restrictMailbox({ action: restricted ? 'add' : 'del', scope, email });
        results.push({ email, ok: true, error: null });
      } catch (err) {
        results.push({ email, ok: false, error: messageOf(err) });
      }
    }
    return results;
  }

  /** `quota: null` clears the quota for every listed address; a string sets the same value for all of them. Bulk **restrict and quota only** — there is no `bulkDelete` on this class (FEATURE_MATRIX.md §3: "the blast radius is unacceptable for mail data"). */
  async bulkQuota(
    addresses: readonly string[],
    quota: string | null,
  ): Promise<BulkMailboxResultItem[]> {
    await assertQuotasSupported(this.driver);
    const results: BulkMailboxResultItem[] = [];
    for (const email of addresses) {
      try {
        if (quota === null) {
          await this.driver.deleteQuota({ email });
        } else {
          await this.driver.setQuota({ email, quota });
        }
        results.push({ email, ok: true, error: null });
      } catch (err) {
        results.push({ email, ok: false, error: messageOf(err) });
      }
    }
    return results;
  }
}
