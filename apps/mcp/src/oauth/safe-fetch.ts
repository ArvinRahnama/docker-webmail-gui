/**
 * SSRF-guarded HTTPS GET, used for exactly one purpose: fetching an OAuth
 * Client ID Metadata Document named by an untrusted `client_id` URL
 * (MCP 2026-07-28 §Client ID Metadata Document Security; SECURITY.md §3.4).
 *
 * Controls, all enforced here rather than by the caller:
 *  - `https:` only, default port 443 only, no credentials in the URL;
 *  - the hostname is resolved and **every** resolved address must be
 *    public unicast — loopback, RFC 1918, CGNAT, link-local (incl. the
 *    169.254.169.254 cloud metadata endpoint), ULA, multicast,
 *    documentation and reserved ranges are refused, IPv4-mapped/NAT64 IPv6
 *    is unwrapped first;
 *  - the check runs inside the connection's own DNS lookup, so the socket
 *    connects to the very address that was validated (no DNS-rebinding gap
 *    between "check" and "connect");
 *  - redirects are not followed; the response must be `application/json`,
 *    at most {@link MAX_METADATA_BYTES}, within {@link FETCH_TIMEOUT_MS}.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, request } from 'undici';

export const MAX_METADATA_BYTES = 10 * 1024;
export const FETCH_TIMEOUT_MS = 5000;

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** Extracts an embedded IPv4 address from IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96) IPv6. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return mapped[1];
  const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped?.[1] !== undefined && hexMapped[2] !== undefined) {
    const high = parseInt(hexMapped[1], 16);
    const low = parseInt(hexMapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

/** True when `address` is a public unicast IP this service may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4 !== null) return !blocked.check(v4, 'ipv4');
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

/** A `net` lookup that only ever yields public addresses — and fails if any resolved address is not public. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err !== null) {
      callback(err, '', 0);
      return;
    }
    const list = addresses as unknown as LookupAddress[];
    if (list.length === 0 || list.some((entry) => !isPublicAddress(entry.address))) {
      callback(
        Object.assign(
          new Error('Refusing to connect: the host resolves to a non-public address.'),
          {
            code: 'EDWGSSRF',
          },
        ) as NodeJS.ErrnoException,
        '',
        0,
      );
      return;
    }
    const wantAll =
      typeof options === 'object' && options !== null && 'all' in options && options.all === true;
    if (wantAll) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      return;
    }
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
};

let sharedAgent: Agent | null = null;
function agent(): Agent {
  // undici's `request` never follows redirects unless a redirect
  // interceptor is composed in, and none is: a 3xx is just a non-200 below.
  sharedAgent ??= new Agent({
    connect: { lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS },
    headersTimeout: FETCH_TIMEOUT_MS,
    bodyTimeout: FETCH_TIMEOUT_MS,
  });
  return sharedAgent;
}

export interface FetchedDocument {
  readonly json: unknown;
  /** Seconds the document may be cached for, from Cache-Control max-age (clamped by the caller). */
  readonly maxAgeSeconds: number | null;
}

export type MetadataFetcher = (url: URL) => Promise<FetchedDocument>;

/** Validates the URL shape before any network activity. */
export function assertFetchableUrl(url: URL): void {
  if (url.protocol !== 'https:') throw new SafeFetchError('Only https:// URLs are fetched.');
  if (url.port !== '' && url.port !== '443')
    throw new SafeFetchError('Only the default HTTPS port is fetched.');
  if (url.username !== '' || url.password !== '')
    throw new SafeFetchError('URLs with credentials are refused.');
  if (url.hash !== '') throw new SafeFetchError('URLs with fragments are refused.');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    throw new SafeFetchError('IP-literal hosts are refused; a DNS name is required.');
  }
  if (
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    !url.hostname.includes('.')
  ) {
    throw new SafeFetchError('Local or single-label hosts are refused.');
  }
}

export const safeFetchJson: MetadataFetcher = async (url) => {
  assertFetchableUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await request(url, {
      method: 'GET',
      dispatcher: agent(),
      headers: {
        accept: 'application/json',
        'user-agent': 'docker-webmail-gui-mcp/1 (client-metadata)',
      },
      signal: controller.signal,
    });
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new SafeFetchError(
        `The client metadata document returned HTTP ${response.statusCode}.`,
      );
    }
    const contentType = String(response.headers['content-type'] ?? '');
    if (!/^application\/(?:[\w.+-]*\+)?json\b/i.test(contentType)) {
      await response.body.dump();
      throw new SafeFetchError('The client metadata document is not application/json.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > MAX_METADATA_BYTES) {
        controller.abort();
        throw new SafeFetchError('The client metadata document is too large.');
      }
      chunks.push(buffer);
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new SafeFetchError('The client metadata document is not valid JSON.');
    }
    const cacheControl = String(response.headers['cache-control'] ?? '');
    const maxAge = /max-age=(\d+)/i.exec(cacheControl);
    return { json, maxAgeSeconds: maxAge?.[1] !== undefined ? Number(maxAge[1]) : null };
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    const code = (err as { code?: unknown }).code;
    if (code === 'EDWGSSRF' || (err as { cause?: { code?: unknown } }).cause?.code === 'EDWGSSRF') {
      throw new SafeFetchError('Refusing to fetch client metadata from a non-public address.');
    }
    throw new SafeFetchError('The client metadata document could not be fetched.');
  } finally {
    clearTimeout(timer);
  }
};
