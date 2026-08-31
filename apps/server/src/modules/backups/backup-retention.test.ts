import { describe, expect, it } from 'vitest';
import { selectBackupsForDeletion, type RetentionCandidate } from './backup-retention.js';

/** Builds N candidates, newest first (index 0 is the most recent), spaced one day apart ending `now`. */
function candidates(count: number, now: Date): RetentionCandidate[] {
  const day = 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_unused, i) => ({
    id: `bkp_${i}`,
    createdAt: new Date(now.getTime() - i * day).toISOString(),
  }));
}

const NOW = new Date('2026-08-31T00:00:00.000Z');

describe('selectBackupsForDeletion', () => {
  it('keeps the N most recent and deletes the rest', () => {
    const toDelete = selectBackupsForDeletion(
      candidates(5, NOW),
      { keep: 3, maxAgeDays: null },
      NOW,
    );
    // bkp_0..bkp_2 kept, bkp_3 and bkp_4 deleted.
    expect(toDelete).toEqual(['bkp_3', 'bkp_4']);
  });

  it('never deletes the single most recent backup, whatever the age cap says', () => {
    // Every backup is older than 1 day except the newest; keep=1 with an age
    // cap must still leave exactly the newest.
    const toDelete = selectBackupsForDeletion(candidates(4, NOW), { keep: 1, maxAgeDays: 1 }, NOW);
    expect(toDelete).not.toContain('bkp_0');
    expect(toDelete).toEqual(['bkp_1', 'bkp_2', 'bkp_3']);
  });

  it('deletes anything older than the age cap even within the keep window', () => {
    // keep=10 (nothing beyond keep), but a 5-day cap prunes bkp_6..bkp_9.
    const toDelete = selectBackupsForDeletion(
      candidates(10, NOW),
      { keep: 10, maxAgeDays: 5 },
      NOW,
    );
    expect(toDelete).toEqual(['bkp_6', 'bkp_7', 'bkp_8', 'bkp_9']);
  });

  it('never deletes the protected (just-created) backup', () => {
    const list = candidates(5, NOW);
    // Protect an otherwise-deletable id.
    const toDelete = selectBackupsForDeletion(list, { keep: 1, maxAgeDays: null }, NOW, 'bkp_4');
    expect(toDelete).not.toContain('bkp_4');
  });

  it('returns nothing when everything fits the policy', () => {
    expect(
      selectBackupsForDeletion(candidates(2, NOW), { keep: 7, maxAgeDays: null }, NOW),
    ).toEqual([]);
  });

  it('handles an empty list', () => {
    expect(selectBackupsForDeletion([], { keep: 7, maxAgeDays: 30 }, NOW)).toEqual([]);
  });
});
