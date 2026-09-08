/**
 * Direct unit tests for `extractBakedImageFacts` (SU-E, docs/design/
 * self-update.md §9.8) — the parsing edge cases that
 * `operations.test.ts`'s `panel.selfUpdateCheck` suite does not itself
 * enumerate one by one (it exercises the handler end to end against a
 * few whole-env fixtures; this file pins the pure function's own
 * behaviour on malformed/partial input directly).
 */
import { describe, expect, it } from 'vitest';
import { extractBakedImageFacts } from './image-refs.js';

describe('extractBakedImageFacts', () => {
  it('reads a well-formed registry-origin env', () => {
    expect(extractBakedImageFacts(['DWG_VERSION=0.4.0', 'DWG_IMAGE_ORIGIN=registry'])).toEqual({
      version: '0.4.0',
      origin: 'registry',
    });
  });

  it('reads a well-formed source-origin env', () => {
    expect(extractBakedImageFacts(['DWG_VERSION=0.4.0', 'DWG_IMAGE_ORIGIN=source'])).toEqual({
      version: '0.4.0',
      origin: 'source',
    });
  });

  it('is order-independent and ignores unrelated env entries', () => {
    expect(
      extractBakedImageFacts([
        'PATH=/usr/local/sbin:/usr/local/bin',
        'DWG_IMAGE_ORIGIN=registry',
        'NODE_ENV=production',
        'DWG_VERSION=1.2.3',
      ]),
    ).toEqual({ version: '1.2.3', origin: 'registry' });
  });

  it('returns both null for a completely empty env', () => {
    expect(extractBakedImageFacts([])).toEqual({ version: null, origin: null });
  });

  it('returns both null when neither key is present at all (an image built before this baking existed)', () => {
    expect(extractBakedImageFacts(['PATH=/usr/bin', 'NODE_ENV=production'])).toEqual({
      version: null,
      origin: null,
    });
  });

  it('never fabricates a version from a malformed DWG_VERSION value', () => {
    expect(
      extractBakedImageFacts(['DWG_VERSION=not-a-version', 'DWG_IMAGE_ORIGIN=registry']),
    ).toEqual({ version: null, origin: 'registry' });
  });

  it('never fabricates an origin from a value outside the closed vocabulary', () => {
    expect(
      extractBakedImageFacts(['DWG_VERSION=0.4.0', 'DWG_IMAGE_ORIGIN=pulled-by-hand']),
    ).toEqual({
      version: '0.4.0',
      origin: null,
    });
  });

  it('ignores an entry with no "=" at all rather than throwing', () => {
    expect(() =>
      extractBakedImageFacts(['DWG_VERSION=0.4.0', 'DWG_IMAGE_ORIGIN=registry', 'MALFORMED_ENTRY']),
    ).not.toThrow();
    expect(
      extractBakedImageFacts(['MALFORMED_ENTRY', 'DWG_VERSION=0.4.0', 'DWG_IMAGE_ORIGIN=registry']),
    ).toEqual({ version: '0.4.0', origin: 'registry' });
  });

  it("takes the last occurrence when a key somehow appears twice — trusts Docker's own already-merged env, does not second-guess it", () => {
    expect(
      extractBakedImageFacts([
        'DWG_VERSION=0.1.0',
        'DWG_IMAGE_ORIGIN=source',
        'DWG_VERSION=0.4.0',
        'DWG_IMAGE_ORIGIN=registry',
      ]),
    ).toEqual({ version: '0.4.0', origin: 'registry' });
  });

  it('accepts a value containing "=" itself (only the first "=" is the key/value separator)', () => {
    // Not a realistic DWG_VERSION/DWG_IMAGE_ORIGIN value, but proves the
    // split logic does not truncate an otherwise-unrelated entry that
    // happens to contain more than one "=".
    expect(
      extractBakedImageFacts([
        'SOME_OTHER=a=b=c',
        'DWG_VERSION=0.4.0',
        'DWG_IMAGE_ORIGIN=registry',
      ]),
    ).toEqual({ version: '0.4.0', origin: 'registry' });
  });
});
