import { describe, expect, it } from 'vitest';
import { parseBearerChallenge, parseImageReference } from './real-registry-client.js';

describe('parseImageReference', () => {
  it('parses a fully-qualified GHCR reference', () => {
    expect(parseImageReference('ghcr.io/docker-mailserver/docker-mailserver:latest')).toEqual({
      registryHost: 'ghcr.io',
      repository: 'docker-mailserver/docker-mailserver',
      tag: 'latest',
    });
  });

  it('parses a Docker Hub reference with no explicit host', () => {
    expect(parseImageReference('mailserver/docker-mailserver:14.0.0')).toEqual({
      registryHost: 'registry-1.docker.io',
      repository: 'mailserver/docker-mailserver',
      tag: '14.0.0',
    });
  });

  it('parses a bare official-image name with no namespace or tag', () => {
    expect(parseImageReference('nginx')).toEqual({
      registryHost: 'registry-1.docker.io',
      repository: 'library/nginx',
      tag: 'latest',
    });
  });

  it('normalises an explicit docker.io host to the real registry hostname', () => {
    expect(parseImageReference('docker.io/library/nginx:1.27')).toEqual({
      registryHost: 'registry-1.docker.io',
      repository: 'library/nginx',
      tag: '1.27',
    });
  });

  it('does not mistake a registry port for a tag separator', () => {
    expect(parseImageReference('myregistry.local:5000/team/app:v2')).toEqual({
      registryHost: 'myregistry.local:5000',
      repository: 'team/app',
      tag: 'v2',
    });
  });

  it('defaults to "latest" when a self-hosted registry reference has no tag', () => {
    expect(parseImageReference('myregistry.local:5000/team/app')).toEqual({
      registryHost: 'myregistry.local:5000',
      repository: 'team/app',
      tag: 'latest',
    });
  });
});

describe('parseBearerChallenge', () => {
  it('parses a standard Docker Hub-style challenge', () => {
    const header =
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:mailserver/docker-mailserver:pull"';
    expect(parseBearerChallenge(header)).toEqual({
      realm: 'https://auth.docker.io/token',
      service: 'registry.docker.io',
      scope: 'repository:mailserver/docker-mailserver:pull',
    });
  });

  it('parses a challenge with only a realm', () => {
    expect(parseBearerChallenge('Bearer realm="https://ghcr.io/token"')).toEqual({
      realm: 'https://ghcr.io/token',
      service: null,
      scope: null,
    });
  });

  it('is case-insensitive on the "Bearer" scheme', () => {
    expect(parseBearerChallenge('bearer realm="https://example.com/token"')).toEqual({
      realm: 'https://example.com/token',
      service: null,
      scope: null,
    });
  });

  it('returns null for a non-Bearer challenge', () => {
    expect(parseBearerChallenge('Basic realm="something"')).toBeNull();
  });

  it('returns null when no realm attribute is present', () => {
    expect(parseBearerChallenge('Bearer service="registry.docker.io"')).toBeNull();
  });
});
