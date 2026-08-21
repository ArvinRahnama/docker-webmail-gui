/**
 * Real {@link RegistryClientPort} — speaks the OCI/Docker Distribution
 * v2 HTTP API directly (no client library; `undici`, already a budgeted
 * dependency, is the entire footprint). Two requests, standard for *any*
 * v2-compliant registry, not hardcoded per-host:
 *
 *  1. `GET /v2/<repository>/manifests/<tag>` anonymously. A public image
 *     on a registry that requires bearer tokens (Docker Hub, GHCR, both
 *     of which docker-mailserver images are published to) answers `401`
 *     with a `Www-Authenticate: Bearer realm="…" ,service="…",scope="…"`
 *     challenge (RFC 6750 + the OCI distribution spec's token-auth
 *     extension) — this is not docker-mailserver-specific behaviour, it
 *     is how the protocol itself works.
 *  2. Fetch a token from that challenge's `realm` and retry with
 *     `Authorization: Bearer <token>`.
 *
 * The digest itself is the `Docker-Content-Digest` response header, never
 * computed locally — recomputing a manifest digest correctly requires
 * reproducing the registry's own canonical JSON serialisation, which this
 * project has no reason to reimplement when the registry already states
 * it authoritatively in a header on the exact response being read.
 *
 * Not exercised against a real registry by any test in this repository —
 * there is no network access assumed for `npm test` — but it type-checks
 * and its two pure helpers ({@link parseImageReference},
 * `parseBearerChallenge`) are unit-tested directly. Same "not exercised,
 * but real" status as `apps/broker/src/docker-client.ts`.
 */
import { request } from 'undici';
import type { RegistryClientPort } from './types.js';

export interface ParsedImageReference {
  readonly registryHost: string;
  readonly repository: string;
  readonly tag: string;
}

const DOCKER_HUB_REGISTRY_HOST = 'registry-1.docker.io';

function looksLikeRegistryHost(candidate: string): boolean {
  // Per Docker's own reference-parsing rule: the first path segment is a
  // registry host only if it contains a '.', a ':' (a port), or is
  // literally "localhost" — otherwise the whole reference is assumed to
  // be a Docker Hub repository (possibly namespaced, e.g. "library/nginx"
  // or a user/org name like "mailserver/docker-mailserver").
  return candidate === 'localhost' || candidate.includes('.') || candidate.includes(':');
}

/**
 * Splits an image reference like `ghcr.io/docker-mailserver/docker-mailserver:latest`
 * or a bare `nginx` into registry host, repository and tag — the same
 * three components `docker pull` itself derives before ever making a
 * request. Exported for direct unit testing (`real-registry-client.test.ts`).
 */
export function parseImageReference(reference: string): ParsedImageReference {
  const lastColon = reference.lastIndexOf(':');
  const lastSlash = reference.lastIndexOf('/');
  // A ':' after the final '/' is a tag separator; a ':' at or before it
  // is part of a "host:port" registry address, not a tag.
  const hasTag = lastColon > lastSlash;
  const withoutTag = hasTag ? reference.slice(0, lastColon) : reference;
  const tag = hasTag ? reference.slice(lastColon + 1) : 'latest';

  const firstSlash = withoutTag.indexOf('/');
  if (firstSlash === -1) {
    // A single bare name ("nginx") is a Docker Hub *official* image,
    // which lives under the "library/" namespace.
    return { registryHost: DOCKER_HUB_REGISTRY_HOST, repository: `library/${withoutTag}`, tag };
  }

  const firstSegment = withoutTag.slice(0, firstSlash);
  if (looksLikeRegistryHost(firstSegment)) {
    return {
      registryHost: firstSegment === 'docker.io' ? DOCKER_HUB_REGISTRY_HOST : firstSegment,
      repository: withoutTag.slice(firstSlash + 1),
      tag,
    };
  }
  // No host segment at all ("mailserver/docker-mailserver") -> Docker Hub,
  // whole thing is the (namespaced) repository.
  return { registryHost: DOCKER_HUB_REGISTRY_HOST, repository: withoutTag, tag };
}

export interface BearerChallenge {
  readonly realm: string;
  readonly service: string | null;
  readonly scope: string | null;
}

/** Parses a `Www-Authenticate: Bearer realm="…",service="…",scope="…"` header (RFC 6750 §3, OCI distribution spec token auth). Returns `null` for anything that is not a Bearer challenge with at least a `realm`. */
export function parseBearerChallenge(header: string): BearerChallenge | null {
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const attributes = new Map<string, string>();
  const attributePattern = /(\w+)="([^"]*)"/g;
  for (const match of header.matchAll(attributePattern)) {
    attributes.set(match[1]!, match[2]!);
  }
  const realm = attributes.get('realm');
  if (realm === undefined) return null;
  return {
    realm,
    service: attributes.get('service') ?? null,
    scope: attributes.get('scope') ?? null,
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function fetchBearerToken(challenge: BearerChallenge): Promise<string | null> {
  const url = new URL(challenge.realm);
  if (challenge.service !== null) url.searchParams.set('service', challenge.service);
  if (challenge.scope !== null) url.searchParams.set('scope', challenge.scope);

  const response = await request(url, { method: 'GET' });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    await response.body.dump();
    return null;
  }
  const body = (await response.body.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? null;
}

const MANIFEST_ACCEPT_HEADER = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ');

const REQUEST_TIMEOUT_MS = 10_000;

export class RealRegistryClient implements RegistryClientPort {
  async resolveTagDigest(imageReference: string): Promise<string | null> {
    try {
      const { registryHost, repository, tag } = parseImageReference(imageReference);
      const manifestUrl = `https://${registryHost}/v2/${repository}/manifests/${tag}`;
      const requestOptions = {
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      };

      let response = await request(manifestUrl, {
        method: 'GET',
        headers: { accept: MANIFEST_ACCEPT_HEADER },
        ...requestOptions,
      });

      if (response.statusCode === 401) {
        const challengeText = firstHeaderValue(response.headers['www-authenticate']);
        await response.body.dump();
        const challenge = challengeText !== undefined ? parseBearerChallenge(challengeText) : null;
        if (challenge === null) return null;

        const token = await fetchBearerToken(challenge);
        if (token === null) return null;

        response = await request(manifestUrl, {
          method: 'GET',
          headers: { accept: MANIFEST_ACCEPT_HEADER, authorization: `Bearer ${token}` },
          ...requestOptions,
        });
      }

      const digestHeader = firstHeaderValue(response.headers['docker-content-digest']);
      await response.body.dump();

      if (response.statusCode < 200 || response.statusCode >= 300) return null;
      return digestHeader ?? null;
    } catch {
      // Network/DNS/TLS/parse failure — an unreachable registry is
      // Unknown, never a thrown error (see this method's own doc comment
      // on `RegistryClientPort`).
      return null;
    }
  }
}
