/**
 * Picks up users' spam / not-spam reports (docker/dms/README.md) from the
 * mail log and applies them to each mailbox's sender lists.
 *
 * docker/dms/dwg/sender-report writes one `dwg-sender-report:` line per
 * report; this reads the log's tail through the broker's existing
 * read-only `logs.file` operation — no new broker capability — on a fixed
 * interval. It does nothing while the integration is not installed.
 * Same timer discipline as `rspamd-sampler.ts`: `.unref()`d, stopped on
 * close, and a tick never overlaps the previous one.
 */
import type { Logger } from 'pino';
import { LOGS_TAIL_MAX } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/index.js';
import { parseSenderReports } from '../../drivers/dms/maillog-parser.js';
import { recordAuditEvent } from '../../platform/audit.js';
import type { Database } from '../../platform/db.js';
import type { SenderListsService } from './sender-lists.service.js';

const DEFAULT_COLLECT_INTERVAL_MS = 60_000;

export interface SenderReportCollectorDeps {
  readonly db: Database;
  readonly brokerClient: BrokerClient;
  readonly senderListsService: SenderListsService;
  readonly logger: Logger;
}

export async function collectSenderReportsOnce(deps: SenderReportCollectorDeps): Promise<number> {
  const integration = await deps.senderListsService.integration();
  if (!integration.installed) return 0;

  const lines = await deps.brokerClient.logsFile('mail', { tail: LOGS_TAIL_MAX });
  const reports = parseSenderReports(lines);
  if (reports.length === 0) return 0;

  const applied = await deps.senderListsService.applyReports(reports);
  for (const report of applied) {
    if (report.list === null) continue;
    recordAuditEvent(deps.db, {
      actor: { adminId: null, label: `mailbox:${report.mailbox}` },
      action: 'sender_list.report',
      target: { type: 'mailbox', id: report.mailbox },
      result: 'success',
      ip: null,
      userAgent: null,
      details: {
        report: report.action,
        list: report.list,
        kind: report.kind,
        value: report.value,
        outcome: report.outcome,
      },
    });
  }
  if (applied.length > 0) {
    deps.logger.info(
      { reports: applied.length },
      'Applied spam / not-spam reports to sender lists',
    );
  }
  return applied.length;
}

export interface SenderReportCollectorHandle {
  stop(): void;
}

export function startSenderReportCollector(
  deps: SenderReportCollectorDeps,
  intervalMs: number = DEFAULT_COLLECT_INTERVAL_MS,
): SenderReportCollectorHandle {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void collectSenderReportsOnce(deps)
      .catch((err: unknown) => {
        deps.logger.warn(
          { err },
          'Collecting spam / not-spam reports failed; retrying next interval',
        );
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
