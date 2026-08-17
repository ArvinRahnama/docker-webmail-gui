/**
 * Fixture provenance: **GENERATED locally with `openssl`**, not captured
 * from a live system — there is no live docker-mailserver container in
 * this environment (ARCHITECTURE.md §9), and there is no way to "capture"
 * a TLS certificate other than generating one, unlike the text-based DMS
 * config fixtures elsewhere in this codebase that can quote a real
 * upstream example verbatim. Both certificates are real, structurally
 * valid X.509 certificates (openssl validated the chain when signing the
 * CA-issued one) — only their *origin* is synthetic test data, not their
 * shape. Neither file below is a private key; the matching `.key` files
 * used to generate these were discarded, consistent with this project
 * never handling a TLS private key in the API layer (FEATURE_MATRIX.md
 * §12).
 *
 * `FIXTURE_SELF_SIGNED_CERT`: `openssl req -x509 -newkey rsa:2048 -nodes
 * -days 825 -subj "/C=US/ST=Testing/L=Testing/O=Docker Webmail GUI Test
 * Fixtures/CN=mail.example.com" -addext
 * "subjectAltName=DNS:mail.example.com,DNS:example.com,DNS:www.example.com"`
 * — subject and issuer are identical (genuinely self-signed).
 *
 * `FIXTURE_CA_SIGNED_CERT`: a leaf certificate for the same CN, signed by
 * a separately-generated "Test Root CA" certificate (`openssl x509 -req
 * ... -CA ca.crt -CAkey ca.key`) — subject and issuer differ, exercising
 * the `isSelfSigned: false` path.
 *
 * Both certificates: `notBefore=2026-08-16`, `notAfter=2028-11-18`
 * (825 days), RSA 2048-bit, SHA-256 signature.
 */

export const FIXTURE_SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIEDDCCAvSgAwIBAgIURzJMiammfYzfxtze3T2MUSok80owDQYJKoZIhvcNAQEL
BQAwdzELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB1Rlc3RpbmcxEDAOBgNVBAcMB1Rl
c3RpbmcxKTAnBgNVBAoMIERvY2tlciBXZWJtYWlsIEdVSSBUZXN0IEZpeHR1cmVz
MRkwFwYDVQQDDBBtYWlsLmV4YW1wbGUuY29tMB4XDTI2MDgxNjIyNTgzMFoXDTI4
MTExODIyNTgzMFowdzELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB1Rlc3RpbmcxEDAO
BgNVBAcMB1Rlc3RpbmcxKTAnBgNVBAoMIERvY2tlciBXZWJtYWlsIEdVSSBUZXN0
IEZpeHR1cmVzMRkwFwYDVQQDDBBtYWlsLmV4YW1wbGUuY29tMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwkIVfUks9SViV4c25nn4utykpkviefwOIXa5
mdezxyeYTfvo6IFkiY9i8a8OOxt7O9bds3CfXXlrerKEdrxlYWxpYbVWOgljBHdT
596+br8pztyNqGjpPRiuRV02x9P85mA+IqJwv2ihvHFf9vO87DLVosRrLWQaiMVR
qGTBdZicIH7VcMVemrrbrOTXjTXSDG+D2d60weAArWN5KreYoYwmSfXGpiX5CiZK
fB2WnsbhUopv093Ltmi4NAjJQcD2Sg8eCf6jknkkq8E4icyoPHtW35KzeWp52R8x
MaPGPrM1LL17Q/zk6dVGndHR9VItJb8ql4CYc1YHU1Qs3Ka48QIDAQABo4GPMIGM
MB0GA1UdDgQWBBQ9T0UEVSNz5xgR+gFcsBgfaaweQTAfBgNVHSMEGDAWgBQ9T0UE
VSNz5xgR+gFcsBgfaaweQTAPBgNVHRMBAf8EBTADAQH/MDkGA1UdEQQyMDCCEG1h
aWwuZXhhbXBsZS5jb22CC2V4YW1wbGUuY29tgg93d3cuZXhhbXBsZS5jb20wDQYJ
KoZIhvcNAQELBQADggEBAJ+UZDVEfv2OAoYUC70LICJNfWgVYoG3RNE5JvDPyFJa
uIr6yoWC+ygyjdAiz8VaWG20gvyjLQgvN17LT5aFBffLr8FOQvkfZQioAMVs49Lz
sWybWSUFkdGb5B3r9+rlWS2v4Q1cKN7uL+/gtbwtjv4sIAAQY9VAoHk9Y9FrNWS/
hwTepy+2hvcDeVstpg59/cvk+QCGgFnAADel8FY0e2tpJUmdqb9K7RQ+M/0T+1oV
yEDwUzX0Zo5SHv3Cu+1bN5/WPtpBXtvLRZEwXZMX4eS0NNSmkKi/WetKMzPWDqQT
av0NHRGTctP20sLTVD+W5bavfUptFclw+zsyGFeRl6w=
-----END CERTIFICATE-----
`;

export const FIXTURE_CA_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDwDCCAqigAwIBAgIUJrdxcbHMuXpnAsbKGXKC2MTRd+0wDQYJKoZIhvcNAQEL
BQAwYTELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB1Rlc3RpbmcxKTAnBgNVBAoMIERv
Y2tlciBXZWJtYWlsIEdVSSBUZXN0IEZpeHR1cmVzMRUwEwYDVQQDDAxUZXN0IFJv
b3QgQ0EwHhcNMjYwODE2MjI1ODMwWhcNMjgxMTE4MjI1ODMwWjBlMQswCQYDVQQG
EwJVUzEQMA4GA1UECAwHVGVzdGluZzEpMCcGA1UECgwgRG9ja2VyIFdlYm1haWwg
R1VJIFRlc3QgRml4dHVyZXMxGTAXBgNVBAMMEG1haWwuZXhhbXBsZS5jb20wggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDYOohRiZr8VaGlMSNSjICbMEcm
3NTLnCaDB8EwZ5TI8JDDMbt7Sz5DrFlgAV23YZXL0YsxMkfp/qFQ1jAEuDSb5XVO
KsE4dcORqgkxRDt8nyXa6enD5q4YZl+e9ZylwmlxTjR8nXxCXMsrmX/FpHydf8tJ
2Rm5iGT63kPmZuuB7rax/irDAbvqsmXDSUpD62RbnPzXk4gehN4BEjbjfPEhQbvW
Ne5cYxQ67/N647YIwuFlwdFkLFMhNCSB9LqEJPuKdwkX5htad7KT7Bb+30hDeX7R
/H+zlThKpFlyRkQvUSmXWcTyZDDtTJMyxTXa2ef9uOJH63PnbADv8ByOAde3AgMB
AAGjbDBqMCgGA1UdEQQhMB+CEG1haWwuZXhhbXBsZS5jb22CC2V4YW1wbGUuY29t
MB0GA1UdDgQWBBTZb6dKAr3RqSnuumzf4XOffxBzCjAfBgNVHSMEGDAWgBRLpvcZ
9iMK3/g0Thq6v/Tufbu4JzANBgkqhkiG9w0BAQsFAAOCAQEAcI279ZbzSl9fluiR
mkHtJdODXdFTQpqzQ7qmobrFflKM/M6e+mCNXznDwwhgQ5/lqe/+P2jA2R/fqnbm
YsosKuZxl4o8QPvpPPVyUqpTv9zhfQWu2v2ZgEo5DcvsEf3Bia3HkfWs7yHa3UJQ
dKLzyk/cdWvI8/hmiuKfbCKi6SRGBqBPb+0xvQPlgDQK9tDs4jWOf/YuBUDGErtU
94Ot0GoCE9zuoqDTxQ2RhWvejp9ylsS+ha77+P4k/mgcDV/fnQZmxJ+UACo411Zh
LqrNl8PYhTwTyo8Ul0nJLgE6fIleWgJFBDPn1dxa7YlvW1B07kZrtRePQyJCbWoW
359ndg==
-----END CERTIFICATE-----
`;

/** Not a certificate at all — exercises the parser's malformed-input path. */
export const FIXTURE_MALFORMED_CERT =
  '-----BEGIN CERTIFICATE-----\nnot-actually-base64!!!\n-----END CERTIFICATE-----\n';
