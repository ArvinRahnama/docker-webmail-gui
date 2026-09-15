import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../platform/config.js';
import {
  describeSetting,
  filterStartupOverrides,
  findSettingDefinition,
} from './settings-allowlist.js';

const config = loadConfig({ LOG_LEVEL: 'info' });

describe('describeSetting — pendingValue', () => {
  it('is null when there is no saved override', () => {
    const definition = findSettingDefinition('LOG_LEVEL')!;
    const described = describeSetting(definition, config, false, null);
    expect(described.value).toBe('info');
    expect(described.pendingValue).toBeNull();
  });

  it('surfaces a saved override that differs from the running value', () => {
    const definition = findSettingDefinition('LOG_LEVEL')!;
    const described = describeSetting(definition, config, false, 'debug');
    expect(described.value).toBe('info');
    expect(described.pendingValue).toBe('debug');
  });

  it('is null once the saved override matches the running value again', () => {
    const definition = findSettingDefinition('LOG_LEVEL')!;
    const described = describeSetting(definition, config, false, 'info');
    expect(described.pendingValue).toBeNull();
  });

  it('never echoes a pending value for a masked secret, even when one is saved', () => {
    const definition = findSettingDefinition('RSPAMD_PASSWORD')!;
    const described = describeSetting(definition, config, false, 'a-new-password');
    expect(described.masked).toBe(true);
    expect(described.value).toBeNull();
    expect(described.pendingValue).toBeNull();
  });

  it('does show the pending value once the secret is revealed', () => {
    const definition = findSettingDefinition('RSPAMD_PASSWORD')!;
    const described = describeSetting(definition, config, true, 'a-new-password');
    expect(described.masked).toBe(false);
    expect(described.pendingValue).toBe('a-new-password');
  });
});

describe('filterStartupOverrides', () => {
  it('keeps an override for an allowlisted, editable key', () => {
    const result = filterStartupOverrides(new Map([['ENABLE_EXEC_CONSOLE', 'true']]));
    expect(result).toEqual({ ENABLE_EXEC_CONSOLE: 'true' });
  });

  it('drops a key that is not in the allowlist at all', () => {
    const result = filterStartupOverrides(new Map([['DATA_DIR', '/tmp/somewhere-else']]));
    expect(result).toEqual({});
  });

  it('drops a read-only key even if one is somehow persisted — BROKER_SHARED_SECRET and DMS_CONTAINER_NAME are each resolved independently by the broker, from its own environment, and never read this settings table', () => {
    const result = filterStartupOverrides(
      new Map([
        ['BROKER_SHARED_SECRET', 'x'.repeat(32)],
        ['DMS_CONTAINER_NAME', 'some-other-container'],
        ['LOG_LEVEL', 'debug'],
      ]),
    );
    expect(result).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('returns an empty object for no overrides', () => {
    expect(filterStartupOverrides(new Map())).toEqual({});
  });
});
