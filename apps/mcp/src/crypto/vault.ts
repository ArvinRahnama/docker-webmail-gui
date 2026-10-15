/**
 * Credential vault: authenticated encryption (AES-256-GCM) of the mailbox
 * IMAP/SMTP password provisioned by the postmaster.
 *
 *  - The key comes from `MCP_VAULT_KEY_FILE` (a mounted secret) and never
 *    touches the database, an image layer, a log line or an API response.
 *  - Every ciphertext gets a fresh 96-bit random IV.
 *  - The additional authenticated data binds a ciphertext to *its* binding
 *    row and mailbox address, so a ciphertext copied onto another row (a
 *    database-level swap) fails authentication instead of decrypting a
 *    different mailbox's password.
 *  - `keyId` (a truncated SHA-256 of the key) is stored beside each
 *    ciphertext so a wrongly-mounted key is reported as `key_mismatch`
 *    rather than as a generic decryption failure.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SealedSecret {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

export class VaultUnavailableError extends Error {
  constructor(readonly reason: 'missing_key' | 'key_mismatch' | 'corrupt') {
    super(
      reason === 'missing_key'
        ? 'The credential vault key is not configured.'
        : reason === 'key_mismatch'
          ? 'The configured vault key does not match the key this credential was encrypted with.'
          : 'A stored credential failed authentication and was not decrypted.',
    );
    this.name = 'VaultUnavailableError';
  }
}

export function vaultKeyId(key: Buffer): string {
  return createHash('sha256')
    .update('dwg-mcp-vault-key-id:')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

function aadFor(bindingId: string, mailbox: string): Buffer {
  return Buffer.from(`dwg-mcp-credential:v1:${bindingId}:${mailbox}`, 'utf8');
}

export class CredentialVault {
  private readonly key: Buffer | null;
  readonly keyId: string | null;

  constructor(key: Buffer | null) {
    if (key !== null && key.length !== 32) {
      throw new Error('vault key must be exactly 32 bytes');
    }
    this.key = key;
    this.keyId = key === null ? null : vaultKeyId(key);
  }

  get available(): boolean {
    return this.key !== null;
  }

  seal(plaintext: string, bindingId: string, mailbox: string): SealedSecret {
    if (this.key === null || this.keyId === null) throw new VaultUnavailableError('missing_key');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aadFor(bindingId, mailbox));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { keyId: this.keyId, iv, ciphertext, authTag: cipher.getAuthTag() };
  }

  open(sealed: SealedSecret, bindingId: string, mailbox: string): string {
    if (this.key === null) throw new VaultUnavailableError('missing_key');
    if (sealed.keyId !== this.keyId) throw new VaultUnavailableError('key_mismatch');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.iv);
      decipher.setAAD(aadFor(bindingId, mailbox));
      decipher.setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new VaultUnavailableError('corrupt');
    }
  }
}
