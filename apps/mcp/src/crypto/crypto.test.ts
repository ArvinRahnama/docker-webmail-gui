import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateConnectionId,
  generateEnrollmentUsername,
  generateOpaqueToken,
  generateSetupPassword,
  normalizeSetupPassword,
} from './random.js';
import { CredentialVault, VaultUnavailableError } from './vault.js';
import { hashSecret, verifySecret, DUMMY_SECRET_HASH } from './password-hash.js';

describe('identifier and secret generation', () => {
  it('connection ids are 130-bit random, URL-safe, and never repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, generateConnectionId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^c[0-9a-z]{26}$/);
  });

  it('enrollment usernames are distinct from the mailbox and unguessable', () => {
    const name = generateEnrollmentUsername();
    expect(name).toMatch(/^mcp-[0-9a-z]{16}$/);
    expect(new Set(Array.from({ length: 500 }, generateEnrollmentUsername)).size).toBe(500);
  });

  it('setup passwords use an unambiguous alphabet, ≈139 bits, and are independent of any input', () => {
    const passwords = Array.from({ length: 500 }, generateSetupPassword);
    expect(new Set(passwords).size).toBe(500);
    for (const password of passwords) {
      expect(password).toMatch(
        /^[ACDEFGHJKMNPQRTUVWXY34679]{5}(-[ACDEFGHJKMNPQRTUVWXY34679]{5}){5}$/,
      );
      expect(password).not.toMatch(/[01258BILOSZ]/);
    }
    // The generator takes no arguments at all — nothing about a mailbox, domain or admin can influence it.
    expect(generateSetupPassword.length).toBe(0);
  });

  it('normalizes typing differences without losing entropy', () => {
    expect(normalizeSetupPassword('  ackmn-pqrtu \n')).toBe('ACKMN-PQRTU');
  });

  it('opaque tokens carry 256 bits', () => {
    const token = generateOpaqueToken('mcp_at');
    expect(Buffer.from(token.slice('mcp_at_'.length), 'base64url')).toHaveLength(32);
  });
});

describe('setup password hashing', () => {
  it('hashes with Argon2id and verifies only the right secret', async () => {
    const hash = await hashSecret('ACKMN-PQRTU');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('ACKMN');
    expect(await verifySecret(hash, 'ACKMN-PQRTU')).toBe(true);
    expect(await verifySecret(hash, 'ACKMN-PQRTV')).toBe(false);
  });

  it('fails closed on a malformed hash and verifies the dummy hash false', async () => {
    expect(await verifySecret('not-a-hash', 'x')).toBe(false);
    expect(await verifySecret(DUMMY_SECRET_HASH, 'anything')).toBe(false);
  });
});

describe('credential vault (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('round-trips and never stores plaintext', () => {
    const vault = new CredentialVault(key);
    const sealed = vault.seal('imap-password-123', 'mb_1', 'sales@example.test');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('imap-password-123');
    expect(sealed.iv).toHaveLength(12);
    expect(vault.open(sealed, 'mb_1', 'sales@example.test')).toBe('imap-password-123');
  });

  it('uses a fresh IV per encryption', () => {
    const vault = new CredentialVault(key);
    const a = vault.seal('same', 'mb_1', 'sales@example.test');
    const b = vault.seal('same', 'mb_1', 'sales@example.test');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('binds ciphertext to its binding and mailbox (a swapped row does not decrypt)', () => {
    const vault = new CredentialVault(key);
    const sealed = vault.seal('sales-password', 'mb_sales', 'sales@example.test');
    expect(() => vault.open(sealed, 'mb_support', 'support@example.test')).toThrow(
      VaultUnavailableError,
    );
    expect(() => vault.open(sealed, 'mb_sales', 'support@example.test')).toThrow(
      VaultUnavailableError,
    );
  });

  it('detects tampering', () => {
    const vault = new CredentialVault(key);
    const sealed = vault.seal('secret', 'mb_1', 'a@example.test');
    const tampered = {
      ...sealed,
      ciphertext: Buffer.from(sealed.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b))),
    };
    expect(() => vault.open(tampered, 'mb_1', 'a@example.test')).toThrow(VaultUnavailableError);
  });

  it('reports a different key as key_mismatch and a missing key as missing_key', () => {
    const sealed = new CredentialVault(key).seal('secret', 'mb_1', 'a@example.test');
    try {
      new CredentialVault(randomBytes(32)).open(sealed, 'mb_1', 'a@example.test');
      expect.unreachable();
    } catch (err) {
      expect((err as VaultUnavailableError).reason).toBe('key_mismatch');
    }
    expect(() => new CredentialVault(null).seal('x', 'mb_1', 'a@example.test')).toThrow(
      /not configured/,
    );
    expect(() => new CredentialVault(Buffer.alloc(16))).toThrow();
  });
});
