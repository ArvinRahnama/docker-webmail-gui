import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './version.js';

describe('APP_VERSION', () => {
  it('is a non-empty semver-shaped string sourced from the repo root package.json', () => {
    expect(APP_VERSION).toBeTypeOf('string');
    expect(APP_VERSION.length).toBeGreaterThan(0);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
