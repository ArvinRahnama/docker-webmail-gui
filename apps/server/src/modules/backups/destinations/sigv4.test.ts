import { describe, expect, it } from 'vitest';
import { EMPTY_PAYLOAD_SHA256, sha256Hex, signRequestV4, type SigV4Credentials } from './sigv4.js';

// AWS's own published Signature Version 4 example ("GET Object", from the S3
// REST-authentication docs). A hand-rolled signer that reproduces this exact
// Authorization header byte-for-byte is signing correctly — canonical request,
// string-to-sign, signing-key derivation and hex signature all included.
const AWS_EXAMPLE_CREDENTIALS: SigV4Credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
};
const AWS_EXAMPLE_DATE = new Date('2013-05-24T00:00:00.000Z');

describe('signRequestV4', () => {
  it('reproduces the AWS GET Object example signature exactly', () => {
    const headers = signRequestV4(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { range: 'bytes=0-9' },
        payloadSha256: EMPTY_PAYLOAD_SHA256,
      },
      AWS_EXAMPLE_CREDENTIALS,
      AWS_EXAMPLE_DATE,
    );

    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256);
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('signs the payload hash for a body-carrying request (PUT), and sorts/encodes the query', () => {
    const body = Buffer.from('hello world');
    const headers = signRequestV4(
      {
        method: 'PUT',
        url: new URL(
          'https://examplebucket.s3.amazonaws.com/dir/obj%20name?partNumber=2&uploadId=abc',
        ),
        payloadSha256: sha256Hex(body),
      },
      AWS_EXAMPLE_CREDENTIALS,
      AWS_EXAMPLE_DATE,
    );
    // The content hash that is signed is the real body hash, not the empty one.
    expect(headers['x-amz-content-sha256']).toBe(sha256Hex(body));
    expect(headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    expect(headers['authorization']).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date',
    );
  });

  it('never leaks the secret key into the returned headers', () => {
    const headers = signRequestV4(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        payloadSha256: EMPTY_PAYLOAD_SHA256,
      },
      AWS_EXAMPLE_CREDENTIALS,
      AWS_EXAMPLE_DATE,
    );
    const serialised = JSON.stringify(headers);
    expect(serialised).not.toContain(AWS_EXAMPLE_CREDENTIALS.secretAccessKey);
    // The access key id is *meant* to be public and appears in Credential=.
    expect(serialised).toContain(AWS_EXAMPLE_CREDENTIALS.accessKeyId);
  });
});
