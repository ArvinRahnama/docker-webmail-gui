import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMcpConfig, McpConfigError, parseVaultKey } from './config.js';

const HEX_KEY = 'a'.repeat(64);

function problems(env: Record<string, string>, files: Record<string, string> = {}): string[] {
  try {
    loadMcpConfig(env, {
      readFile: (path) => {
        const value = files[path];
        if (value === undefined) throw new Error('ENOENT');
        return value;
      },
    });
    return [];
  } catch (err) {
    if (err instanceof McpConfigError) return [...err.problems];
    throw err;
  }
}

describe('apps/mcp configuration', () => {
  it('requires the vault key in production, and refuses the fake mail backend', () => {
    const found = problems({ APP_MODE: 'production', MCP_MAIL_BACKEND: 'fake' });
    expect(found.some((p) => p.includes('MCP_VAULT_KEY'))).toBe(true);
    expect(found.some((p) => p.includes('fake'))).toBe(true);
  });

  it('reads the vault key from a file and never echoes its value', () => {
    const config = loadMcpConfig(
      { APP_MODE: 'production', MCP_VAULT_KEY_FILE: '/run/secrets/k' },
      { readFile: () => `${HEX_KEY}\n` },
    );
    expect(config.vaultKey).toHaveLength(32);
    expect(config.mailBackend).toBe('imap');
    expect(config.requireHttps).toBe(true);

    const bad = problems({ APP_MODE: 'production', MCP_VAULT_KEY: 'not-a-key-zzzz' });
    expect(bad.join('\n')).not.toContain('not-a-key-zzzz');
  });

  it('rejects setting the vault key both inline and as a file', () => {
    expect(
      problems({ MCP_VAULT_KEY: HEX_KEY, MCP_VAULT_KEY_FILE: '/x' }, { '/x': HEX_KEY }).some((p) =>
        p.includes('both set'),
      ),
    ).toBe(true);
  });

  describe('generateMissingVaultKey', () => {
    const dirs: string[] = [];
    afterEach(() => {
      while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
    });
    function dataDir(): string {
      const dir = mkdtempSync(join(tmpdir(), 'dwg-mcp-key-'));
      dirs.push(dir);
      return join(dir, 'mcp');
    }
    const production = (dir: string, extra: Record<string, string> = {}) =>
      loadMcpConfig(
        { APP_MODE: 'production', MCP_DATA_DIR: dir, ...extra },
        { generateMissingVaultKey: true },
      );

    it('creates <dataDir>/vault.key (0600) on first start and reuses it afterwards', () => {
      const dir = dataDir();
      const first = production(dir);
      const keyPath = join(dir, 'vault.key');
      expect(first.vaultKey).toHaveLength(32);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(keyPath, 'utf8').trim()).toBe(first.vaultKey?.toString('hex'));
      expect(production(dir).vaultKey?.equals(first.vaultKey as Buffer)).toBe(true);
    });

    it('lets a configured key win, warning only when it differs from a generated one', () => {
      const dir = dataDir();
      const generated = production(dir).vaultKey as Buffer;

      const matching = production(dir, { MCP_VAULT_KEY: generated.toString('hex') });
      expect(matching.warnings).toEqual([]);

      const differing = production(dir, { MCP_VAULT_KEY: HEX_KEY });
      expect(differing.vaultKey?.toString('hex')).toBe(HEX_KEY);
      expect(differing.warnings.some((w) => w.includes('differs from the generated one'))).toBe(
        true,
      );
      expect(differing.warnings.join('\n')).not.toContain(HEX_KEY);
    });

    it('never writes a key when one is configured', () => {
      const dir = dataDir();
      production(dir, { MCP_VAULT_KEY: HEX_KEY });
      expect(() => statSync(join(dir, 'vault.key'))).toThrow();
    });

    it('refuses to start when the key cannot be created', () => {
      const dir = dataDir();
      writeFileSync(dir, '');
      expect(() => production(join(dir, 'mcp'))).toThrow(McpConfigError);
    });
  });

  it('generates a fresh in-process control secret every time; it is never configurable', () => {
    const a = loadMcpConfig({});
    const b = loadMcpConfig({ MCP_CONTROL_SECRET: 's'.repeat(40) });
    expect(a.controlSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(b.controlSecret).not.toBe(a.controlSecret);
    expect(b.controlSecret).not.toBe('s'.repeat(40));
  });

  it('keeps its database under the server data directory unless MCP_DATA_DIR says otherwise', () => {
    expect(loadMcpConfig({}, { defaultDataDir: '/app/data/mcp' }).dataDir).toBe('/app/data/mcp');
    expect(
      loadMcpConfig({ MCP_DATA_DIR: '/elsewhere' }, { defaultDataDir: '/app/data/mcp' }).dataDir,
    ).toBe('/elsewhere');
  });

  it('validates the public URL as a bare origin', () => {
    expect(problems({ MCP_PUBLIC_URL: 'https://mcp.example.com/' }).length).toBeGreaterThan(0);
    expect(problems({ MCP_PUBLIC_URL: 'https://mcp.example.com/path' }).length).toBeGreaterThan(0);
    expect(problems({ MCP_PUBLIC_URL: 'https://mcp.example.com' })).toEqual([]);
  });

  it('parses hex and base64 vault keys of exactly 32 bytes', () => {
    expect(parseVaultKey(HEX_KEY)).toHaveLength(32);
    expect(parseVaultKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(parseVaultKey('abcd')).toBeNull();
  });

  it('development defaults are safe: MCP disabled until the postmaster enables it is a settings concern; fake backend only in dev', () => {
    const config = loadMcpConfig({});
    expect(config.isProduction).toBe(false);
    expect(config.mailBackend).toBe('fake');
    expect(config.warnings.length).toBeGreaterThan(0);
  });
});
