import { describe, expect, it } from 'vitest';
import { SENDER_LIST_MAX_ENTRIES, type SenderListEntry } from '@dwg/shared';
import { FakeDmsDriver } from '../../drivers/dms/fake-dms-driver.js';
import { DmsCommandExecutionError } from '../../drivers/dms/errors.js';
import {
  parseSenderReportLine,
  type ParsedSenderReport,
} from '../../drivers/dms/maillog-parser.js';
import { SENDER_LISTS_SCRIPT_NAME } from '../../drivers/dms/sender-lists-sieve.js';
import { createDatabase } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { AppError } from '../../platform/errors.js';
import { SenderListsService, reportTarget, upsertEntry } from './sender-lists.service.js';

const MAILBOX = 'user1@example.com';
const NOW = new Date('2026-11-12T12:00:00Z');

function setUp(driver: FakeDmsDriver = new FakeDmsDriver()) {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  return { db, driver, service: new SenderListsService(driver, db) };
}

function report(
  action: 'ham' | 'spam',
  from: string,
  at = '2026-11-12T05:23:35.151724+00:00',
  user = MAILBOX,
): ParsedSenderReport {
  const line = `${at} mail dwg-sender-report: action=${action} user=${user} ip=203.0.113.7 from=${from}`;
  const parsed = parseSenderReportLine(line, NOW);
  if (parsed === null) throw new Error('fixture line did not parse');
  return parsed;
}

describe('reportTarget', () => {
  const local = new Set(['example.com']);

  it('lists the sender domain for an ordinary domain', () => {
    expect(reportTarget('news@shop.example.org', '203.0.113.7', local)).toEqual({
      kind: 'domain',
      value: 'shop.example.org',
    });
  });

  it('lists only the address for a shared mailbox provider, never all of it', () => {
    expect(reportTarget('someone@gmail.com', '203.0.113.7', local)).toEqual({
      kind: 'address',
      value: 'someone@gmail.com',
    });
  });

  it("lists only the address for this server's own domains", () => {
    expect(reportTarget('colleague@example.com', null, local)).toEqual({
      kind: 'address',
      value: 'colleague@example.com',
    });
  });

  it('falls back to the client IP only when there is no usable From address', () => {
    expect(reportTarget(null, '203.0.113.7', local)).toEqual({ kind: 'ip', value: '203.0.113.7' });
    expect(reportTarget(null, null, local)).toBeNull();
  });
});

describe('upsertEntry', () => {
  const entry = (overrides: Partial<SenderListEntry>): SenderListEntry => ({
    list: 'allow',
    kind: 'domain',
    value: 'a.example',
    source: 'report',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('moves a sender from one list to the other rather than listing it twice', () => {
    const result = upsertEntry(
      [entry({})],
      'block',
      { kind: 'domain', value: 'a.example' },
      'report',
      NOW,
    );
    expect(result.ok && result.entries).toEqual([
      entry({ list: 'block', addedAt: NOW.toISOString() }),
    ]);
  });

  it("never lets a report override an administrator's identical entry", () => {
    const admin = entry({ source: 'admin' });
    const result = upsertEntry([admin], 'allow', admin, 'report', NOW);
    expect(result).toEqual({ ok: true, entries: [admin], changed: false });
  });

  it('evicts the oldest reported entry when full, never an administrator entry', () => {
    const full: SenderListEntry[] = [];
    for (let i = 0; i < SENDER_LIST_MAX_ENTRIES; i += 1) {
      full.push(
        entry({
          value: `d${i}.example`,
          source: i === 0 ? 'admin' : 'report',
          addedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    const result = upsertEntry(
      full,
      'allow',
      { kind: 'domain', value: 'new.example' },
      'report',
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(SENDER_LIST_MAX_ENTRIES);
    expect(result.entries.some((e) => e.value === 'd0.example')).toBe(true); // admin kept
    expect(result.entries.some((e) => e.value === 'd1.example')).toBe(false); // oldest report gone
  });

  it('refuses when every entry was added by an administrator', () => {
    const full = Array.from({ length: SENDER_LIST_MAX_ENTRIES }, (_, i) =>
      entry({ value: `d${i}.example`, source: 'admin' }),
    );
    const result = upsertEntry(full, 'allow', { kind: 'domain', value: 'x.example' }, 'admin', NOW);
    expect(result.ok).toBe(false);
  });
});

describe('SenderListsService', () => {
  it('adds and removes entries, storing them in the mailbox script without activating it', async () => {
    const { service, driver } = setUp();
    const added = await service.add(
      MAILBOX,
      { list: 'block', kind: 'domain', value: 'spam.example' },
      NOW,
    );
    expect(added.entries).toEqual([
      {
        list: 'block',
        kind: 'domain',
        value: 'spam.example',
        source: 'admin',
        addedAt: NOW.toISOString(),
      },
    ]);
    const scripts = await driver.sieveList(MAILBOX);
    expect(scripts.find((s) => s.name === SENDER_LISTS_SCRIPT_NAME)?.active).toBe(false);

    const removed = await service.remove(MAILBOX, {
      list: 'block',
      kind: 'domain',
      value: 'spam.example',
    });
    expect(removed.entries).toEqual([]);
  });

  it('reports a hand-edited script as unrecognised instead of guessing at it', async () => {
    const { service, driver } = setUp();
    await driver.sievePut({
      user: MAILBOX,
      script: SENDER_LISTS_SCRIPT_NAME,
      content: 'require ["fileinto"];\n',
    });
    const lists = await service.get(MAILBOX);
    expect(lists.unrecognisedContent).toBe(true);
    expect(lists.entries).toEqual([]);
  });

  it('says 404 when removing an entry that is not there', async () => {
    const { service } = setUp();
    await expect(
      service.remove(MAILBOX, { list: 'allow', kind: 'ip', value: '203.0.113.7' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('allows the sender on "not spam" and blocks it on "spam", which lifts the allow', async () => {
    const { service } = setUp();

    const [ham] = await service.applyReports([report('ham', 'news@shop.example.org')], NOW);
    expect(ham).toMatchObject({ list: 'allow', kind: 'domain', value: 'shop.example.org' });
    expect(ham?.outcome).toBe('Allowed domain shop.example.org.');

    const [spam] = await service.applyReports(
      [report('spam', 'news@shop.example.org', '2026-11-12T06:00:00.000000+00:00')],
      NOW,
    );
    expect(spam?.outcome).toBe('Blocked domain shop.example.org (was allowed).');

    const lists = await service.get(MAILBOX);
    expect(lists.entries).toEqual([
      expect.objectContaining({
        list: 'block',
        kind: 'domain',
        value: 'shop.example.org',
        source: 'report',
      }),
    ]);
    expect(service.listReports(MAILBOX).map((r) => r.action)).toEqual(['spam', 'ham']);
  });

  it('applies each log line once, however many times the same tail is read', async () => {
    const { service } = setUp();
    const line = report('ham', 'news@shop.example.org');
    expect(await service.applyReports([line], NOW)).toHaveLength(1);
    expect(await service.applyReports([line], NOW)).toHaveLength(0);
    expect(await service.applyReports([line, line], NOW)).toHaveLength(0);
  });

  it('ignores lines older than the newest applied report, so pruning can never replay one', async () => {
    const { service } = setUp();
    await service.applyReports(
      [report('ham', 'a@new.example', '2026-11-12T10:00:00.000000+00:00')],
      NOW,
    );
    const stale = report('spam', 'a@old.example', '2026-11-11T10:00:00.000000+00:00');
    expect(await service.applyReports([stale], NOW)).toEqual([]);
  });

  it('keeps a report for the next pass when the mail server is unreachable', async () => {
    class FlakyDriver extends FakeDmsDriver {
      fail = true;
      override async sievePut(params: Parameters<FakeDmsDriver['sievePut']>[0]): Promise<void> {
        if (this.fail) throw new Error('broker unreachable');
        return super.sievePut(params);
      }
    }
    const driver = new FlakyDriver();
    const { service } = setUp(driver);
    const line = report('ham', 'news@shop.example.org');

    await expect(service.applyReports([line], NOW)).rejects.toThrow('broker unreachable');
    expect(service.listReports(null)).toEqual([]);

    driver.fail = false;
    expect(await service.applyReports([line], NOW)).toHaveLength(1);
  });

  it('records, and does not retry, a report Dovecot refuses outright', async () => {
    class RefusingDriver extends FakeDmsDriver {
      override async sievePut(): Promise<void> {
        throw new DmsCommandExecutionError(['doveadm'], 1, 'sieve: compile error');
      }
    }
    const { service } = setUp(new RefusingDriver());
    const [result] = await service.applyReports([report('ham', 'a@shop.example.org')], NOW);
    expect(result?.outcome).toBe('Not applied: sieve: compile error');
    expect(service.listReports(null)).toHaveLength(1);
  });

  it('rejects an invalid mailbox address', async () => {
    const { service } = setUp();
    await expect(service.get('not a mailbox')).rejects.toBeInstanceOf(AppError);
  });
});
