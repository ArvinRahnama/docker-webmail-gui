/**
 * `/api/v1/mail/queue` (M11 gap-closing pass — UX_ARCHITECTURE.md §5.2's
 * `/mail/queue`; `drivers/dms/parsers/postqueue.ts`). A thin read: parse,
 * tally by queue name, hand back — the same grouping
 * `modules/dashboard/dashboard.service.ts`'s queue tile already uses, so
 * the two never disagree about a count. **Read-only** — see this
 * module's own shared schema (`@dwg/shared`'s `mail.ts`) for why
 * flush/hold/delete are a named, reachable gap rather than something
 * quietly half-built here.
 */
import type { MailQueueListResponse } from '@dwg/shared';
import { countByQueueName } from '../../drivers/dms/parsers/postqueue.js';
import type { DmsDriver } from '../../drivers/dms/index.js';

export class QueueService {
  constructor(private readonly driver: DmsDriver) {}

  async list(): Promise<MailQueueListResponse> {
    const result = await this.driver.getMailQueue();
    return {
      entries: [...result.entries],
      byQueue: countByQueueName(result.entries),
      unparseableLines: result.issues.length,
    };
  }
}
