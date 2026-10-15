import { describe, expect, it } from 'vitest';
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
