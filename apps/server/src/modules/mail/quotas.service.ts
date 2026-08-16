/**
 * Storage / quotas service (FEATURE_MATRIX.md §7; UX_ARCHITECTURE.md §5.1
 * row 5: "reframe as **Storage** — a read-oriented report... Editing
 * happens on the mailbox"). **Read-only on purpose** — there is no
 * `create`/`update`/`delete` here; quota mutations live on
 * `MailboxesService` (`setQuota`/`clearQuota`/`bulkQuota`), reached from
 * the mailbox, not from this report.
 */
import type { QuotaReportEntry } from '@dwg/shared';
import type { DmsDriver } from '../../drivers/dms/index.js';
import type { QuotaUsageResult } from '../../drivers/dms/quota-usage.js';
import { toMailboxUsageDto } from './mail-mappers.js';

export class QuotasService {
  constructor(private readonly driver: DmsDriver) {}

  /**
   * One entry per configured quota (`dovecot-quotas.cf`), each joined
   * with live usage where the address is also a real mailbox. Sorted by
   * `percentUsed` descending (nulls — unknown or unlimited — last), so
   * "who is near the limit" leads exactly as UX_ARCHITECTURE.md §5.1
   * describes, whatever order the caller's own list happened to be in.
   */
  async listReport(): Promise<QuotaReportEntry[]> {
    const [quotasResult, accountsResult] = await Promise.all([
      this.driver.listQuotas(),
      this.driver.listMailboxes(),
    ]);
    const accountEmails = new Set(accountsResult.entries.map((account) => account.email));

    const entries = await Promise.all(
      quotasResult.entries.map(async (quota): Promise<QuotaReportEntry> => {
        const usageResult: QuotaUsageResult = accountEmails.has(quota.email)
          ? await this.driver.getMailboxUsage(quota.email)
          : { ok: false, reason: 'no matching mailbox account for this quota entry' };
        const usage = toMailboxUsageDto(usageResult);
        const percentUsed =
          usage.available && usage.storageBytesLimit !== null && usage.storageBytesUsed !== null
            ? usage.storageBytesUsed / usage.storageBytesLimit
            : null;

        return { email: quota.email, domain: quota.domain, quota: quota.quota, usage, percentUsed };
      }),
    );

    return entries.sort((a, b) => {
      if (a.percentUsed === null) return b.percentUsed === null ? 0 : 1;
      if (b.percentUsed === null) return -1;
      return b.percentUsed - a.percentUsed;
    });
  }
}
