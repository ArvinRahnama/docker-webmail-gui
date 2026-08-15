#!/usr/bin/env node
/**
 * Workspace dependency consistency gate.
 *
 * Fails when the same package is declared at incompatible major versions
 * across workspaces — e.g. `packages/shared` on `zod@^3` while `apps/server`
 * is on `zod@^4`.
 *
 * Why this exists: that exact skew happened on 2026-08-16 and was invisible
 * to every check we had. Dependabot upgraded zod to v4 in the three apps;
 * `packages/shared` was created afterwards from an older dependency list and
 * asked for `^3.24.1`. npm hoisted a single zod@3 to satisfy the lowest
 * declaration, so three merged "upgrade to zod 4" pull requests went green
 * while the installed version silently stayed on v3. Lint, typecheck, test
 * and build all passed, because they were consistently testing the *old*
 * version.
 *
 * npm does notice — `npm ls` reports ELSPROBLEMS — but nothing was running
 * it, and its output is noisy enough to be ignored. This check is narrow and
 * says exactly which workspaces disagree.
 *
 * Usage: node scripts/check-dep-consistency.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** Workspace globs are simple here (`apps/*`, `packages/*`), so expand them directly. */
function findPackageJsonPaths(root) {
  const paths = [join(root, 'package.json')];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(groupDir, entry.name, 'package.json');
      if (existsSync(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

/**
 * Extract the major version a range asks for. Handles the forms we actually
 * use (`^4.4.3`, `~1.2.0`, `4.4.3`, `>=4.0.0`). Anything exotic — `*`, `latest`,
 * a git or file URL, a workspace protocol — returns null and is skipped rather
 * than guessed at.
 */
function majorOf(range) {
  if (typeof range !== 'string') return null;
  const match = /^[\^~>=<\s]*(\d+)\./.exec(range.trim());
  return match ? match[1] : null;
}

function main() {
  const root = process.cwd();
  const declarations = new Map(); // package name -> Map<major, string[] workspaces>

  for (const path of findPackageJsonPaths(root)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      console.error(`Could not parse ${path}: ${error.message}`);
      process.exit(2);
    }

    const workspace = manifest.name ?? path;
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        // Internal workspace packages are linked, not resolved from the
        // registry, so their ranges are not a skew risk.
        if (dependency.startsWith('@dwg/')) continue;

        const major = majorOf(range);
        if (major === null) continue;

        if (!declarations.has(dependency)) declarations.set(dependency, new Map());
        const byMajor = declarations.get(dependency);
        if (!byMajor.has(major)) byMajor.set(major, []);
        byMajor.get(major).push(`${workspace} (${field}: ${range})`);
      }
    }
  }

  const conflicts = [];
  for (const [dependency, byMajor] of declarations) {
    if (byMajor.size > 1) conflicts.push([dependency, byMajor]);
  }

  if (conflicts.length === 0) {
    console.log(
      `Checked ${declarations.size} distinct dependencies across workspaces: no major-version skew.`,
    );
    return;
  }

  console.error(
    `${conflicts.length} dependency/dependencies declared at conflicting major versions:\n`,
  );
  for (const [dependency, byMajor] of conflicts) {
    console.error(`  ${dependency}`);
    for (const [major, workspaces] of [...byMajor].sort()) {
      console.error(`    major ${major}:`);
      for (const workspace of workspaces) console.error(`      - ${workspace}`);
    }
    console.error('');
  }
  console.error(
    'npm resolves a single hoisted copy in this situation, so one of these majors is\n' +
      'silently not installed and its workspace is being tested against the other.\n' +
      'Align the ranges, reinstall, and re-run the tests.',
  );
  process.exit(1);
}

main();
