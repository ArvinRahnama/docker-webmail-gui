/**
 * Password hashing (SECURITY.md §3.5, §3.10). Argon2id via
 * `@node-rs/argon2` — we implement no cryptography ourselves
 * (ARCHITECTURE.md §3).
 */
import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP-baseline Argon2id parameters (OWASP Password Storage Cheat
 * Sheet: m=19456 KiB / 19 MiB, t=2, p=1 as the minimum recommended
 * configuration for Argon2id). `@node-rs/argon2` already defaults to
 * this exact configuration, but the values are named explicitly here so
 * a future change to the library's own defaults can never silently
 * change what gets stored.
 *
 * `hashPassword` stores the full PHC-encoded string returned by
 * `hash()` (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`) — algorithm,
 * version, parameters and salt are all embedded in it, so `verify()`
 * always re-derives using the parameters a given hash was actually
 * created with. That means changing these constants later only affects
 * *new* hashes; every existing hash keeps verifying correctly against
 * the parameters it already carries.
 */
export const ARGON2_OPTIONS = Object.freeze({
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

/** Hashes a plaintext password. Returns the full encoded PHC string — store this, never the plaintext. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Verifies `password` against a previously-stored encoded hash (from {@link hashPassword}). */
export function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  return verify(encodedHash, password);
}

/**
 * A precomputed, validly-encoded Argon2id hash (same parameters as
 * {@link ARGON2_OPTIONS}) of an arbitrary fixed string that is not, and
 * will never be, a real administrator's password.
 *
 * The login flow calls `verifyPassword` against this constant — at the
 * same cost as a real verification — whenever the submitted email does
 * not match any administrator, so that the *time* a login request takes
 * never reveals whether the account exists. Do not "optimise" this away
 * by short-circuiting on an unknown email: that fast path is exactly
 * the timing side-channel this constant exists to eliminate.
 *
 * It is a hardcoded literal rather than something computed at module
 * load so that importing this module never pays an extra Argon2 hash
 * (tens of milliseconds at these parameters) on every process start —
 * and every test file. Any validly-encoded hash under our parameters
 * serves identically as the comparison target; the plaintext it was
 * generated from is irrelevant and deliberately not recorded anywhere.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Ip6fS2VJoDyTaLwKrKhV2Q$CTWMrvI1mmBHN/aA1BIdcv+GK7LOAxDRfkkjmM/EW88';
