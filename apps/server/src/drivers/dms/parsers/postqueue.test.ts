import { describe, expect, it } from 'vitest';
import { countByQueueName, parsePostqueueJson } from './postqueue.js';

const VALID_LINE = JSON.stringify({
  queue_name: 'deferred',
  queue_id: '4Xk2mP1abc',
  arrival_time: 1_755_123_456,
  message_size: 2345,
  forced_expire: false,
  sender: 'a@example.com',
  recipients: [{ address: 'b@example.org', delay_reason: 'connection timed out' }],
});

describe('parsePostqueueJson', () => {
  it('parses one JSON-Lines entry per queue file, per docs/research §3', () => {
    const result = parsePostqueueJson(VALID_LINE);
    expect(result.issues).toHaveLength(0);
    expect(result.entries).toEqual([
      {
        queueName: 'deferred',
        queueId: '4Xk2mP1abc',
        arrivalTime: 1_755_123_456,
        messageSizeBytes: 2345,
        sender: 'a@example.com',
        recipientCount: 1,
      },
    ]);
  });

  it('never throws on an empty queue (Postfix emits nothing at all)', () => {
    expect(parsePostqueueJson('')).toEqual({ entries: [], issues: [] });
    expect(parsePostqueueJson('\n\n')).toEqual({ entries: [], issues: [] });
  });

  it('parses multiple lines, one object per line', () => {
    const second = JSON.stringify({
      queue_name: 'active',
      queue_id: 'zzz999',
      arrival_time: 1,
      message_size: 10,
      sender: 'c@example.com',
      recipients: [],
    });
    const result = parsePostqueueJson(`${VALID_LINE}\n${second}`);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]?.queueName).toBe('active');
    expect(result.entries[1]?.recipientCount).toBe(0);
  });

  it('reports a malformed line as an issue, with its line number and raw text, rather than throwing or silently dropping it', () => {
    const result = parsePostqueueJson(`${VALID_LINE}\nnot json at all`);
    expect(result.entries).toHaveLength(1);
    expect(result.issues).toEqual([{ line: 2, raw: 'not json at all', reason: 'Not valid JSON.' }]);
  });

  it('reports a JSON object missing a required field as an issue rather than guessing', () => {
    const missingQueueName = JSON.stringify({
      queue_id: 'abc',
      arrival_time: 1,
      message_size: 1,
      sender: 'x@example.com',
    });
    const result = parsePostqueueJson(missingQueueName);
    expect(result.entries).toHaveLength(0);
    expect(result.issues[0]?.reason).toMatch(/queue_name/);
  });

  it('rejects an unrecognised queue_name rather than accepting anything as a fifth queue', () => {
    const badQueueName = JSON.stringify({
      queue_name: 'not-a-real-queue',
      queue_id: 'abc',
      arrival_time: 1,
      message_size: 1,
      sender: 'x@example.com',
    });
    const result = parsePostqueueJson(badQueueName);
    expect(result.entries).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
  });
});

describe('countByQueueName', () => {
  it('tallies by queue_name with every known queue name always present, zero-filled', () => {
    const { entries } = parsePostqueueJson(VALID_LINE);
    expect(countByQueueName(entries)).toEqual({
      incoming: 0,
      active: 0,
      deferred: 1,
      hold: 0,
    });
  });

  it('returns all zeros for an empty entry list, never an absent key', () => {
    expect(countByQueueName([])).toEqual({ incoming: 0, active: 0, deferred: 0, hold: 0 });
  });
});
