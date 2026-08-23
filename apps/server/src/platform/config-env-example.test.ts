/**
 * `.env.example` and the config schema must describe the same variables.
 *
 * `docs/configuration.md` deliberately does not restate `.env.example`,
 * and tells operators it is "the authoritative reference … checked
 * against the code's own schema, so it cannot quietly drift". That claim
 * was written in M14 with nothing enforcing it — found by M15's audit,
 * which is exactly the class of thing the audit was for. This file is
 * what makes it true.
 *
 * Both directions matter and fail differently. A variable in the schema
 * but not the file is undiscoverable: it works, and no operator knows it
 * exists. A variable in the file but not the schema is worse: an operator
 * sets it, the server ignores it, and nothing says so — which is how
 * someone ends up believing they turned something off.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_ENV_KEYS } from './config.js';

/**
 * The broker's own variables, extracted from its schema source rather
 * than imported: `apps/server` must never depend on `apps/broker` (they
 * are separate deployables sharing only `@dwg/shared` — ARCHITECTURE.md
 * §4), and hardcoding the list here would be one more copy to drift.
 * Reading the file keeps this self-maintaining; the sanity check below
 * makes a refactor that defeats the extraction fail loudly rather than
 * silently pass with an empty set.
 */
function brokerEnvKeys(): string[] {
  const path = fileURLToPath(new URL('../../../broker/src/config.ts', import.meta.url));
  const text = readFileSync(path, 'utf8');
  const keys = new Set<string>();
  for (const match of text.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys].sort();
}

/** Every `KEY=` assignment in `.env.example`, commented lines excluded. */
function envExampleKeys(): string[] {
  const path = fileURLToPath(new URL('../../../../.env.example', import.meta.url));
  const text = readFileSync(path, 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) keys.add(match[1]);
  }
  return [...keys].sort();
}

describe('.env.example matches the configuration schema', () => {
  it('documents every variable the schema reads', () => {
    const documented = new Set(envExampleKeys());
    const undocumented = [...CONFIG_ENV_KEYS].filter((key) => !documented.has(key));
    expect(undocumented, 'schema variables missing from .env.example').toEqual([]);
  });

  it('documents no variable neither tier reads', () => {
    // `.env.example` is the whole project's file: one `.env` configures
    // both containers, so the union is the right comparison. Splitting it
    // per tier would mean two files an operator has to keep consistent.
    const known = new Set<string>([...CONFIG_ENV_KEYS, ...brokerEnvKeys()]);
    const unknown = envExampleKeys().filter((key) => !known.has(key));
    expect(unknown, 'variables in .env.example that neither tier reads').toEqual([]);
  });

  it('sanity check: both extractions actually parsed something', () => {
    expect(envExampleKeys().length).toBeGreaterThan(10);
    expect(brokerEnvKeys().length).toBeGreaterThan(4);
  });
});
