import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISIBLE_SERVICE_PATTERNS,
  isContainerVisible,
  isImageVisible,
  matchesAnyPattern,
  matchesServiceIdentity,
  parseVisiblePatterns,
  stripLeadingSlash,
  type ServiceIdentity,
} from './visibility.js';

const MAIL: ServiceIdentity = { containerName: 'mailserver', containerLabel: null };
const SERVER: ServiceIdentity = { containerName: 'dwg-server', containerLabel: null };
const BROKER: ServiceIdentity = { containerName: 'dwg-broker', containerLabel: null };
const IDENTITIES = [MAIL, SERVER, BROKER];
const PATTERNS = DEFAULT_VISIBLE_SERVICE_PATTERNS;

describe('matchesServiceIdentity', () => {
  it('matches an exact container name, slash-normalised', () => {
    expect(matchesServiceIdentity({ names: ['/mailserver'], labels: {} }, MAIL)).toBe(true);
    expect(matchesServiceIdentity({ names: ['mailserver'], labels: {} }, MAIL)).toBe(true);
  });

  it('never matches a name by substring — the Docker name-filter pitfall', () => {
    expect(matchesServiceIdentity({ names: ['mailserver-old'], labels: {} }, MAIL)).toBe(false);
    expect(matchesServiceIdentity({ names: ['not-mailserver'], labels: {} }, MAIL)).toBe(false);
  });

  it('matches a key=value label selector exactly, and it wins over the name', () => {
    const byLabel: ServiceIdentity = {
      containerName: 'ignored',
      containerLabel: 'com.docker-webmail-gui.role=mail',
    };
    expect(
      matchesServiceIdentity(
        { names: ['whatever'], labels: { 'com.docker-webmail-gui.role': 'mail' } },
        byLabel,
      ),
    ).toBe(true);
    expect(
      matchesServiceIdentity(
        { names: ['whatever'], labels: { 'com.docker-webmail-gui.role': 'server' } },
        byLabel,
      ),
    ).toBe(false);
  });
});

describe('glob matching', () => {
  it('treats * as a wildcard and everything else literally', () => {
    expect(matchesAnyPattern('roundcube-db', ['roundcube*'])).toBe(true);
    expect(matchesAnyPattern('roundcube', ['roundcube*'])).toBe(true);
    expect(
      matchesAnyPattern('ghcr.io/docker-mailserver/docker-mailserver:latest', ['*mailserver*']),
    ).toBe(true);
    expect(matchesAnyPattern('nginx-proxy-manager', PATTERNS)).toBe(false);
  });

  it('anchors the whole string — a prefix pattern does not match mid-string', () => {
    expect(matchesAnyPattern('my-roundcube', ['roundcube*'])).toBe(false);
  });

  it('does not let a pattern inject regex metacharacters', () => {
    // The `.` is literal, so `a.c` must not match `abc`.
    expect(matchesAnyPattern('abc', ['a.c'])).toBe(false);
    expect(matchesAnyPattern('a.c', ['a.c'])).toBe(true);
  });
});

describe('isContainerVisible', () => {
  const visibility = { identities: IDENTITIES, patterns: PATTERNS };

  it('shows the three config-known services and roundcube, hides unrelated host containers', () => {
    const visible = ['mailserver', 'dwg-server', 'dwg-broker', 'roundcube', 'roundcube-db'];
    const hidden = ['nginx-proxy-manager', 'mysql', 'owner-website', 'portainer'];
    for (const name of visible) {
      expect(isContainerVisible({ names: [name], labels: {} }, visibility), name).toBe(true);
    }
    for (const name of hidden) {
      expect(isContainerVisible({ names: [name], labels: {} }, visibility), name).toBe(false);
    }
  });

  it('shows a container matched only by label identity', () => {
    const byLabel = {
      identities: [{ containerName: 'x', containerLabel: 'role=mail' }],
      patterns: [],
    };
    expect(isContainerVisible({ names: ['anything'], labels: { role: 'mail' } }, byLabel)).toBe(
      true,
    );
  });
});

describe('isImageVisible', () => {
  const none = new Set<string>();

  it('shows images whose repo tag matches a pattern', () => {
    expect(
      isImageVisible(
        { id: 'sha256:a', repoTags: ['ghcr.io/docker-mailserver/docker-mailserver:latest'] },
        PATTERNS,
        none,
      ),
    ).toBe(true);
    expect(
      isImageVisible({ id: 'sha256:b', repoTags: ['roundcube/roundcubemail:1'] }, PATTERNS, none),
    ).toBe(true);
  });

  it('hides an unrelated image and a dangling (untagged) one', () => {
    expect(isImageVisible({ id: 'sha256:c', repoTags: ['nginx:latest'] }, PATTERNS, none)).toBe(
      false,
    );
    expect(isImageVisible({ id: 'sha256:d', repoTags: [] }, PATTERNS, none)).toBe(false);
  });

  it('shows an image referenced by a visible container even when no tag matches', () => {
    const referenced = new Set(['mariadb:latest', 'sha256:deadbeef']);
    expect(
      isImageVisible({ id: 'sha256:x', repoTags: ['mariadb:latest'] }, PATTERNS, referenced),
    ).toBe(true);
    expect(isImageVisible({ id: 'sha256:deadbeef', repoTags: [] }, PATTERNS, referenced)).toBe(
      true,
    );
  });
});

describe('parseVisiblePatterns', () => {
  it('splits a comma list and trims', () => {
    expect(parseVisiblePatterns('roundcube*, mailserver* ,foo')).toEqual([
      'roundcube*',
      'mailserver*',
      'foo',
    ]);
  });

  it('falls back to defaults on empty/unset rather than hiding everything', () => {
    expect(parseVisiblePatterns(null)).toBe(DEFAULT_VISIBLE_SERVICE_PATTERNS);
    expect(parseVisiblePatterns(undefined)).toBe(DEFAULT_VISIBLE_SERVICE_PATTERNS);
    expect(parseVisiblePatterns('   ')).toBe(DEFAULT_VISIBLE_SERVICE_PATTERNS);
    expect(parseVisiblePatterns(',, ,')).toBe(DEFAULT_VISIBLE_SERVICE_PATTERNS);
  });
});

describe('stripLeadingSlash', () => {
  it('removes exactly one leading slash', () => {
    expect(stripLeadingSlash('/mailserver')).toBe('mailserver');
    expect(stripLeadingSlash('mailserver')).toBe('mailserver');
  });
});
