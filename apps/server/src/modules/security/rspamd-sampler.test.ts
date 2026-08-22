import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { createLogger } from '../../platform/logger.js';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { FakeRspamdClient } from '../../drivers/rspamd/index.js';
import {
  getRspamdTrend,
  getSpamBlocked24h,
  RSPAMD_SCANNED_METRIC,
  RSPAMD_SPAM_METRIC,
  sampleRspamdStatOnce,
} from './rspamd-sampler.js';

function freshDb(): Database {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  return db;
}

function silentLogger() {
  return createLogger({ level: 'silent' });
}

/** Only differs from `FakeDmsDriver` in reporting Rspamd as unsupported — used to exercise the capability-gated skip. */
class RspamdUnsupportedDriver extends FakeDmsDriver {
  override async getCapabilities() {
    const base = await super.getCapabilities();
    return { ...base, rspamd: { supported: false, reason: 'ENABLE_RSPAMD is not set.' } };
  }
}

/**
 * `FakeDmsDriver`'s own fixture environment ships `ENABLE_RSPAMD=0`
 * (`fixtures/env.ts` — deliberately the "off by default" shape a fresh
 * install has), so the happy-path sampling test needs a driver that
 * actually reports Rspamd as enabled.
 */
class RspamdEnabledDriver extends FakeDmsDriver {
  override async getCapabilities() {
    const base = await super.getCapabilities();
    return { ...base, rspamd: { supported: true, reason: null } };
  }
}

describe('sampleRspamdStatOnce', () => {
  it('writes a metric_samples row for spam count and scanned when rspamd is enabled', async () => {
    const db = freshDb();
    const dmsDriver = new RspamdEnabledDriver();
    const rspamdClient = new FakeRspamdClient();

    await sampleRspamdStatOnce({ db, dmsDriver, rspamdClient, logger: silentLogger() });

    const spamRows = db.all('SELECT * FROM metric_samples WHERE metric = ?', [RSPAMD_SPAM_METRIC]);
    const scannedRows = db.all('SELECT * FROM metric_samples WHERE metric = ?', [
      RSPAMD_SCANNED_METRIC,
    ]);
    expect(spamRows).toHaveLength(1);
    expect(scannedRows).toHaveLength(1);
  });

  it('writes nothing when the capability document says Rspamd is unsupported', async () => {
    const db = freshDb();
    const dmsDriver = new RspamdUnsupportedDriver();
    const rspamdClient = new FakeRspamdClient();

    await sampleRspamdStatOnce({ db, dmsDriver, rspamdClient, logger: silentLogger() });

    expect(db.all('SELECT * FROM metric_samples')).toHaveLength(0);
  });

  it('writes nothing (never a fabricated point) when the controller is unreachable', async () => {
    const db = freshDb();
    const dmsDriver = new RspamdEnabledDriver();
    const rspamdClient = new FakeRspamdClient().setUnreachable('connection refused');

    await sampleRspamdStatOnce({ db, dmsDriver, rspamdClient, logger: silentLogger() });

    expect(db.all('SELECT * FROM metric_samples')).toHaveLength(0);
  });

  it('never throws even when the stat response is unparseable', async () => {
    const db = freshDb();
    const dmsDriver = new RspamdEnabledDriver();
    const rspamdClient = new FakeRspamdClient().setStat('garbage, not an object');

    await expect(
      sampleRspamdStatOnce({ db, dmsDriver, rspamdClient, logger: silentLogger() }),
    ).resolves.toBeUndefined();
    expect(db.all('SELECT * FROM metric_samples')).toHaveLength(0);
  });
});

describe('getRspamdTrend', () => {
  it('reports collecting:true with no points when there are fewer than 2 samples', () => {
    const db = freshDb();
    db.run(
      'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
      ['ms_1', new Date().toISOString(), RSPAMD_SPAM_METRIC, 5, null],
    );

    const trend = getRspamdTrend(db);
    expect(trend.collecting).toBe(true);
    expect(trend.points).toEqual([]);
  });

  it('reports collecting:true when samples exist but span less than 24 hours', () => {
    const db = freshDb();
    const now = Date.now();
    for (const offsetMinutes of [0, 30]) {
      db.run(
        'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
        [
          `ms_${offsetMinutes}`,
          new Date(now - offsetMinutes * 60_000).toISOString(),
          RSPAMD_SPAM_METRIC,
          5,
          null,
        ],
      );
    }

    expect(getRspamdTrend(db).collecting).toBe(true);
  });

  it('reports collecting:false with real points once enough history exists', () => {
    const db = freshDb();
    const now = Date.now();
    const hoursAgo = [0, 25, 48];
    for (const hours of hoursAgo) {
      db.run(
        'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
        [
          `ms_${hours}`,
          new Date(now - hours * 3_600_000).toISOString(),
          RSPAMD_SPAM_METRIC,
          hours,
          null,
        ],
      );
    }

    const trend = getRspamdTrend(db, 24 * 7);
    expect(trend.collecting).toBe(false);
    expect(trend.points).toHaveLength(3);
  });

  it('never fabricates a line — an entirely empty table reports collecting:true', () => {
    const db = freshDb();
    const trend = getRspamdTrend(db);
    expect(trend.collecting).toBe(true);
    expect(trend.points).toEqual([]);
  });
});

describe('getSpamBlocked24h', () => {
  it('reports collecting:true, count:null before getRspamdTrend would too — same gate, never a second opinion', () => {
    const db = freshDb();
    db.run(
      'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
      ['ms_1', new Date().toISOString(), RSPAMD_SPAM_METRIC, 5, null],
    );

    const tile = getSpamBlocked24h(db);
    expect(tile).toEqual({ collecting: true, windowHours: 24, count: null });
  });

  it('reports the delta between the oldest and newest sample inside the window once collecting', () => {
    const db = freshDb();
    const now = Date.now();
    // Spans well past 24h so getRspamdTrend's own gate opens; all three
    // fall inside the (default 24h) window this function itself uses to
    // pick first/last, so the delta is 40 - 10 = 30.
    const samples: ReadonlyArray<[hoursAgo: number, value: number]> = [
      [23, 10],
      [12, 25],
      [0, 40],
    ];
    for (const [hoursAgo, value] of samples) {
      db.run(
        'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
        [
          `ms_${hoursAgo}`,
          new Date(now - hoursAgo * 3_600_000).toISOString(),
          RSPAMD_SPAM_METRIC,
          value,
          null,
        ],
      );
    }
    // One more sample outside the 24h window (but old enough to satisfy
    // getRspamdTrend's "spans at least 24h" collecting gate).
    db.run(
      'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
      ['ms_old', new Date(now - 48 * 3_600_000).toISOString(), RSPAMD_SPAM_METRIC, 999, null],
    );

    const tile = getSpamBlocked24h(db);
    expect(tile).toEqual({ collecting: false, windowHours: 24, count: 30 });
  });

  it('never reports a negative count across a counter reset (Rspamd restart) — floors at zero', () => {
    const db = freshDb();
    const now = Date.now();
    const samples: ReadonlyArray<[hoursAgo: number, value: number]> = [
      [23, 100],
      [1, 5], // the counter reset partway through the window
    ];
    for (const [hoursAgo, value] of samples) {
      db.run(
        'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
        [
          `ms_${hoursAgo}`,
          new Date(now - hoursAgo * 3_600_000).toISOString(),
          RSPAMD_SPAM_METRIC,
          value,
          null,
        ],
      );
    }
    db.run(
      'INSERT INTO metric_samples (id, sampled_at, metric, value, tags) VALUES (?, ?, ?, ?, ?)',
      ['ms_old', new Date(now - 48 * 3_600_000).toISOString(), RSPAMD_SPAM_METRIC, 999, null],
    );

    expect(getSpamBlocked24h(db).count).toBe(0);
  });
});
