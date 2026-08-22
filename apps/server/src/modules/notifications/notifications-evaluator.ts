/**
 * Turns {@link DashboardService.getSnapshot}'s real, already-computed
 * signals into persisted, dismissible notification rows — on a timer,
 * mirroring `modules/security/rspamd-sampler.ts`'s exact shape
 * (`startRspamdStatSampler`/`sampleRspamdStatOnce`: an `.unref()`d
 * interval, a `.stop()` handle, and a single-tick function exported
 * separately so tests never have to wait on a real interval).
 *
 * **Deliberately built on the dashboard service, not a second reading of
 * the same subsystems.** `notifications.ts`'s own header states the rule
 * this file exists to keep: no notification here is ever a fact this
 * project computed a second, potentially disagreeing way from what the
 * dashboard itself shows.
 *
 * Every known condition (`NOTIFICATION_DEDUPE_KEYS`) is resolved when it
 * is not currently observed and upserted-active when it is — every tick,
 * for every key — so an admin's dashboard and their notification bell can
 * never drift apart about whether a given problem is still ongoing.
 */
import type { Logger } from 'pino';
import type { DashboardService } from '../dashboard/dashboard.service.js';
import { NOTIFICATION_SOURCES } from './notification-sources.js';
import type { NotificationsRepository } from './notifications.repository.js';

const DEFAULT_EVALUATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const UPDATE_AVAILABLE_KEY = 'update-available';

export interface NotificationsEvaluatorDeps {
  readonly repository: NotificationsRepository;
  /** The one method this module needs — narrowed from the concrete `DashboardService` so a test can supply a plain snapshot-returning stub instead of constructing all ten of that service's own dependencies. */
  readonly dashboardService: Pick<DashboardService, 'getSnapshot'>;
  readonly logger: Logger;
}

/** One evaluation pass — exported directly so tests can assert its exact write behaviour without waiting on a real interval, same convention as `sampleRspamdStatOnce`. */
export async function evaluateNotificationsOnce(deps: NotificationsEvaluatorDeps): Promise<void> {
  const snapshot = await deps.dashboardService.getSnapshot();
  const now = new Date().toISOString();

  const activeProblems = new Map(snapshot.verdict.problems.map((problem) => [problem.id, problem]));

  // Every verdict-problem-derived key: upsert while the problem persists,
  // resolve the moment it no longer appears among this tick's problems.
  for (const [dedupeKey, source] of Object.entries(NOTIFICATION_SOURCES)) {
    if (dedupeKey === UPDATE_AVAILABLE_KEY) continue; // handled separately below — not a verdict "problem" (info-level, routine, not urgent).
    const problem = activeProblems.get(dedupeKey);
    if (problem) {
      deps.repository.upsertActive(
        { dedupeKey, severity: source.severity, title: problem.label, body: problem.message },
        now,
      );
    } else {
      deps.repository.resolveIfActive(dedupeKey, now);
    }
  }

  // `updateAvailable` is a `securityExpiry` fact, not a `verdict.problems`
  // entry (routine, not urgent — it must never push the whole dashboard
  // into a non-healthy tone) — evaluated from its own field instead.
  if (snapshot.securityExpiry.updateAvailable === true) {
    deps.repository.upsertActive(
      {
        dedupeKey: UPDATE_AVAILABLE_KEY,
        severity: NOTIFICATION_SOURCES[UPDATE_AVAILABLE_KEY]!.severity,
        title: 'An update is available',
        body: 'The container registry has a newer image than the one currently running.',
      },
      now,
    );
  } else {
    deps.repository.resolveIfActive(UPDATE_AVAILABLE_KEY, now);
  }
}

export interface NotificationsEvaluatorHandle {
  stop(): void;
}

/** Starts the periodic evaluator. Returned timer is `.unref()`d — never keeps a Node process, or a test's harness, alive on its own; callers still get `stop()` for deterministic cleanup (`app.ts`'s `onClose` hook, mirroring `startRspamdStatSampler`). */
export function startNotificationsEvaluator(
  deps: NotificationsEvaluatorDeps,
  intervalMs: number = DEFAULT_EVALUATE_INTERVAL_MS,
): NotificationsEvaluatorHandle {
  const timer = setInterval(() => {
    void evaluateNotificationsOnce(deps).catch((err: unknown) => {
      deps.logger.warn({ err }, 'Notification evaluation failed');
    });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
