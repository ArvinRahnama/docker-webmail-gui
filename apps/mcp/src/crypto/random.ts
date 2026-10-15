/**
 * Every identifier and secret apps/mcp generates. All randomness is
 * `crypto.randomBytes`/`randomInt`; nothing is derived from the mailbox
 * address, the domain, an administrator password or any other input — the
 * enrollment password in particular must be unguessable from everything the
 * postmaster or an attacker could know about the mailbox.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE32_LOWER = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford, lower-case

function base32(bytes: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** `c` + 26 base32 chars = 130 bits drawn from 17 random bytes; unpredictable, URL-safe, no timestamp. */
export function generateConnectionId(): string {
  return 'c' + base32(randomBytes(17), 26);
}

/** Internal row ids (bindings, grants, operations…): prefix + 26 base32 chars. */
export function generateRowId(prefix: string): string {
  return `${prefix}_${base32(randomBytes(17), 26)}`;
}

/**
 * Enrollment username: `mcp-` + 16 base32 chars (80 bits). An identifier,
 * not a secret — but unguessable, so a username alone reveals nothing and
 * cannot be enumerated.
 */
export function generateEnrollmentUsername(): string {
  return 'mcp-' + base32(randomBytes(10), 16);
}

/**
 * Unambiguous alphabet for the human-typed setup password: upper-case only,
 * with no 0/O, 1/I/L, 5/S, 2/Z or 8/B. 25 symbols → log2(25) ≈ 4.64 bits each.
 */
const SETUP_PASSWORD_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const SETUP_PASSWORD_GROUPS = 6;
const SETUP_PASSWORD_GROUP_LENGTH = 5;

/**
 * Setup password: 6 groups of 5 characters (30 symbols ≈ 139 bits), e.g.
 * `K7QXP-M9DAW-…`. Generated with `randomInt` (rejection-sampled, no modulo
 * bias). Shown to the postmaster exactly once; only its Argon2id hash is kept.
 */
export function generateSetupPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < SETUP_PASSWORD_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < SETUP_PASSWORD_GROUP_LENGTH; i += 1) {
      group += SETUP_PASSWORD_ALPHABET[randomInt(SETUP_PASSWORD_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Typing tolerance: surrounding whitespace is ignored and lower-case is
 * accepted (the alphabet is upper-case only, so this loses no entropy).
 */
export function normalizeSetupPassword(input: string): string {
  return input.trim().toUpperCase();
}

/** Opaque OAuth artefacts: prefix + 256 random bits, base64url. */
export function generateOpaqueToken(
  prefix: 'mcp_at' | 'mcp_rt' | 'mcp_ac' | 'mcp_cs' | 'mcp_tx',
): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

/** SHA-256 hex — the right tool for looking up 256-bit random values (see migration 001). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison via fixed-length digests (no length side-channel). */
export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
