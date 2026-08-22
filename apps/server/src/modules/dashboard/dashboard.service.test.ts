import { describe, expect, it } from 'vitest';
import { worstHealthState } from './dashboard.service.js';

describe('worstHealthState', () => {
  it('defaults to healthy for an empty list', () => {
    expect(worstHealthState([])).toBe('healthy');
  });

  it('ranks critical above everything else', () => {
    expect(worstHealthState(['healthy', 'warning', 'unknown', 'critical'])).toBe('critical');
  });

  it('ranks warning above unknown and healthy', () => {
    expect(worstHealthState(['healthy', 'unknown', 'warning'])).toBe('warning');
  });

  it('ranks unknown above healthy — "could not check" is never reported as healthy', () => {
    expect(worstHealthState(['healthy', 'unknown'])).toBe('unknown');
  });

  it('is healthy only when every input is healthy', () => {
    expect(worstHealthState(['healthy', 'healthy'])).toBe('healthy');
  });
});
