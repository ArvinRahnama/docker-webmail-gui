/**
 * AWS Signature Version 4 for S3 — hand-rolled over `node:crypto`, no AWS SDK
 * (the dependency budget forbids it, and the signing algorithm is small and
 * fully specified). This is the only credential-touching code in the S3
 * destination; it is a pure function of its inputs (request + credentials +
 * clock), so it signs deterministically and is unit-tested against AWS's own
 * published "GET Object" example vector.
 *
 * Signs `host`, `x-amz-date` and `x-amz-content-sha256` plus every header the
 * caller passes in — the minimum S3 requires, plus anything extra (e.g.
 * `range`, `content-type`). The payload hash is passed in already computed, so
 * a multipart part is hashed once and streamed once rather than buffered twice.
 *
 * It never logs, and it returns headers to the caller rather than mutating any
 * shared state — the secret key exists only as a local during the HMAC chain.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  /** Always `'s3'` here, but explicit so the signer stays a general SigV4 implementation. */
  readonly service: string;
}

export interface SigV4SignParams {
  readonly method: string;
  /** Full request URL, including any query string — the canonical query is derived from it. */
  readonly url: URL;
  /** Extra headers to include *and* sign (lowercased internally). `host`/`x-amz-date`/`x-amz-content-sha256` are added automatically. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the request body — {@link EMPTY_PAYLOAD_SHA256} for an empty body, or {@link UNSIGNED_PAYLOAD}. */
  readonly payloadSha256: string;
}

/** SHA-256 of the empty string — the payload hash for any request with no body (GET/DELETE, and the multipart create/complete envelope requests hash their own body instead). */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The literal S3 accepts in place of a payload hash to skip payload signing (used for nothing here — we always sign the real hash — but named for clarity). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * AWS-flavoured URI encoding: percent-encode every byte except the RFC 3986
 * unreserved set (`A-Z a-z 0-9 - _ . ~`). `encodeSlash: false` additionally
 * leaves `/` intact — used for the path, where slashes are segment
 * separators, not data.
 */
function awsUriEncode(input: string, encodeSlash: boolean): string {
  let result = '';
  for (const ch of input) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      result += ch;
    } else if (ch === '/' && !encodeSlash) {
      result += ch;
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        result += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return result;
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  // 2013-05-24T00:00:00.000Z -> 20130524T000000Z
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const names = Object.keys(headers).sort();
  const canonical = names.map((name) => `${name}:${headers[name]}\n`).join('');
  return { canonical, signed: names.join(';') };
}

function canonicalQueryString(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([key, value]) => [awsUriEncode(key, true), awsUriEncode(value, true)] as const,
  );
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function canonicalUri(url: URL): string {
  const encoded = url.pathname
    .split('/')
    .map((segment) => awsUriEncode(segment, true))
    .join('/');
  return encoded === '' ? '/' : encoded;
}

/**
 * Signs `params` and returns the complete header set to send — the caller's
 * headers plus `host`, `x-amz-date`, `x-amz-content-sha256` and
 * `authorization`. Deterministic given `now`.
 */
export function signRequestV4(
  params: SigV4SignParams,
  credentials: SigV4Credentials,
  now: Date,
): Record<string, string> {
  const { amzDate, dateStamp } = amzDates(now);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    headers[key.toLowerCase()] = value.trim();
  }
  headers['host'] = params.url.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = params.payloadSha256;

  const { canonical, signed } = canonicalHeaders(headers);

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri(params.url),
    canonicalQueryString(params.url),
    canonical,
    signed,
    params.payloadSha256,
  ].join('\n');

  const scope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, credentials.region);
  const kService = hmac(kRegion, credentials.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signed}, Signature=${signature}`;

  return { ...headers, authorization };
}
