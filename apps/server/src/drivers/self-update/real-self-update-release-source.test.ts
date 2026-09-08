import { describe, expect, it } from 'vitest';
import { parseVersionFromTag } from './real-self-update-release-source.js';

describe('parseVersionFromTag', () => {
  it('strips a lowercase v prefix', () => {
    expect(parseVersionFromTag('v0.4.0')).toBe('0.4.0');
  });

  it('strips an uppercase V prefix', () => {
    expect(parseVersionFromTag('V1.2.3')).toBe('1.2.3');
  });

  it('accepts a bare version with no prefix at all', () => {
    expect(parseVersionFromTag('2.0.0')).toBe('2.0.0');
  });

  it('rejects a pre-release/build-metadata tag', () => {
    expect(parseVersionFromTag('v0.4.0-rc1')).toBeNull();
    expect(parseVersionFromTag('v0.4.0+build.5')).toBeNull();
  });

  it('rejects a two-segment or four-segment version', () => {
    expect(parseVersionFromTag('v0.4')).toBeNull();
    expect(parseVersionFromTag('v0.4.0.1')).toBeNull();
  });

  it('rejects a non-numeric or differently-shaped tag', () => {
    expect(parseVersionFromTag('latest')).toBeNull();
    expect(parseVersionFromTag('nightly-build')).toBeNull();
    expect(parseVersionFromTag('')).toBeNull();
  });
});
