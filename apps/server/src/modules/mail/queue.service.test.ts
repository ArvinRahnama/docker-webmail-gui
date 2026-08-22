import { describe, expect, it } from 'vitest';
import { FakeDmsDriver } from '../../drivers/dms/index.js';
import { QueueService } from './queue.service.js';

describe('QueueService.list', () => {
  it('returns the real fixture queue, grouped by queue name, with every known name zero-filled', async () => {
    const service = new QueueService(new FakeDmsDriver());
    const result = await service.list();

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.unparseableLines).toBe(0);
    expect(Object.keys(result.byQueue).sort()).toEqual(['active', 'deferred', 'hold', 'incoming']);
    const total = Object.values(result.byQueue).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(result.entries.length);
  });
});
