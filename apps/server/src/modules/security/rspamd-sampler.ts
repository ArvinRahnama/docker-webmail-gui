/**
 * Our own periodic `/stat` sampling into `metric_samples`
 * (FEATURE_MATRIX.md §1, §14: "Rspamd `/history` is a 200-entry
 * in-memory ring buffer lost on restart, so trends require our own
 * sampling. Shows 'Collecting — trend available after 24h' until
 * samples exist."). `metric_samples` is migration 001's own table,
 * built for exactly this ("the only source of spam/queue trend data").
 *
 * Every tick is independently safe to skip: an unreachable controller or
 * a disabled `ENABLE_RSPAMD` deployment simply records nothing that
 * round — there is no code path here that writes a fabricated or
 * interpolated point.
 */
import type { Logger } from 'pino';
import type { RspamdClientPort } from '../../drivers/rspamd/index.js';
import { parseRspamdStat } from '../../drivers/rspamd/index.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import type { Database } from '../../platform/db.js';
import { generateId } from '../../platform/errors.js';
import type { RspamdTrendResponse } from '@dwg/shared';

export const RSPAMD_SPAM_METRIC = 'rspamd.spam_count';
export const RSPAMD_SCANNED_METRIC = 'rspamd.scanned';

const DEFAULT_SAMPLE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const COLLECTING_MIN_SAMPLES = 2;
const COLLECTING_MIN_SPAN_HOURS = 24;
const DEFAULT_TREND_WINDOW_HOURS = 24 * 7;

function recordMetricSample(db: Database, metric: string, value: number): void {
  db.run(
    `INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)`,
    [generateId('ms'), new Date().toISOString(), metric, value, null],
  );
}

export interface RspamdSamplerDeps {
  readonly db: Database;
  readonly dmsDriver: DmsDriver;
  readonly rspamdClient: RspamdClientPort;
  readonly logger: Logger;
}

/** One sampling attempt — exported directly so tests can assert its exact write behaviour without waiting on a real interval. */
export async function sampleRspamdStatOnce(deps: RspamdSamplerDeps): Promise<void> {
  const capabilities = await deps.dmsDriver.getCapabilities();
  if (!capabilities.rspamd.supported) return;

  const result = await deps.rspamdClient.getStat();
  if (!result.ok) {
    deps.logger.debug(
      { error: result.error },
      'Rspamd stat sampling skipped: controller unreachable',
    );
    return;
  }

  const stat = parseRspamdStat(result.value);
  if (stat.spamCount !== null) recordMetricSample(deps.db, RSPAMD_SPAM_METRIC, stat.spamCount);
  if (stat.scanned !== null) recordMetricSample(deps.db, RSPAMD_SCANNED_METRIC, stat.scanned);
}

export interface RspamdSamplerHandle {
  stop(): void;
}

/**
 * Starts the periodic sampler. The returned timer is `.unref()`d so it
 * never keeps a Node process (or a test's harness) alive on its own —
 * callers still get `stop()` for deterministic cleanup (`app.ts`'s
 * `onClose` hook).
 */
export function startRspamdStatSampler(
  deps: RspamdSamplerDeps,
  intervalMs: number = DEFAULT_SAMPLE_INTERVAL_MS,
): RspamdSamplerHandle {
  const timer = setInterval(() => {
    void sampleRspamdStatOnce(deps).catch((err: unknown) => {
      deps.logger.warn({ err }, 'Rspamd stat sampling failed');
    });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * Reads back the sampled trend. `collecting: true` — never a fabricated
 * or interpolated line — until both enough samples exist *and* they span
 * at least 24 hours, matching the brief's exact wording.
 */
export function getRspamdTrend(
  db: Database,
  windowHours: number = DEFAULT_TREND_WINDOW_HOURS,
): RspamdTrendResponse {
  const allSamples = db.all<{ sampled_at: string; value: number }>(
    `SELECT sampled_at, value FROM metric_samples WHERE metric = ? ORDER BY sampled_at ASC`,
    [RSPAMD_SPAM_METRIC],
  );

  if (allSamples.length < COLLECTING_MIN_SAMPLES) {
    return { collecting: true, windowHours, points: [] };
  }

  const oldest = allSamples[0] as { sampled_at: string; value: number };
  const ageHours = (Date.now() - new Date(oldest.sampled_at).getTime()) / 3_600_000;
  if (ageHours < COLLECTING_MIN_SPAN_HOURS) {
    return { collecting: true, windowHours, points: [] };
  }

  const sinceMs = Date.now() - windowHours * 3_600_000;
  const points = allSamples
    .filter((row) => new Date(row.sampled_at).getTime() >= sinceMs)
    .map((row) => ({ sampledAt: row.sampled_at, value: row.value }));

  return { collecting: false, windowHours, points };
}
