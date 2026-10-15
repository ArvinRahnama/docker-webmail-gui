/**
 * Argon2id for enrollment setup passwords — same parameters and library as
 * admin passwords (apps/server/src/modules/auth/password.ts, OWASP baseline).
 * We implement no cryptography ourselves.
 */
import { hash, verify } from '@node-rs/argon2';

export const ARGON2_OPTIONS = Object.freeze({ memoryCost: 19456, timeCost: 2, parallelism: 1 });

export function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON2_OPTIONS);
}

export async function verifySecret(encodedHash: string, secret: string): Promise<boolean> {
  try {
    return await verify(encodedHash, secret);
  } catch {
    // A malformed stored hash must fail closed, never throw past the login path.
    return false;
  }
}

/**
 * Verified against when the submitted username matches nothing, so an
 * unknown username costs the same Argon2 time as a wrong password (no
 * enumeration by timing). The plaintext it was generated from is irrelevant.
 */
export const DUMMY_SECRET_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Ip6fS2VJoDyTaLwKrKhV2Q$CTWMrvI1mmBHN/aA1BIdcv+GK7LOAxDRfkkjmM/EW88';
