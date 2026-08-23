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
 * npm does notice — `npm ls` reports ELSPROBLEMS — and for a long time
 * nothing here ran it, on the reasoning that its output was noisy enough to
 * be ignored. That reasoning turned out to be expensive: see
 * {@link checkTreeIntegrity} below, added after a second skew arrived
 * through a *peer* dependency, where there were never two declarations to
 * compare. `npm ls` is now run too, as the last of three checks.
 *
 * So this file gates three things, narrowest first:
 *   1. declarations agree on a major across workspaces;
 *   2. what is installed matches what is declared;
 *   3. npm itself reports no invalid or missing package in the tree.
 *
 * Usage: node scripts/check-dep-consistency.mjs
 */

import { execFileSync } from 'node:child_process';
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

/**
 * Second check: does what is actually installed match what is declared?
 *
 * Declaration consistency alone is not enough, as we found the hard way. On
 * 2026-08-16 the manifests were corrected to zod ^4 and package-lock.json
 * recorded 4.4.3, but `npm install` was failing on an unrelated ERESOLVE
 * conflict, so node_modules kept zod 3.25.76. Fifty-five tests passed
 * against v3 while every manifest claimed v4 — and the moment v4 was really
 * installed, typecheck failed immediately.
 *
 * Tests are especially poor at catching this: vitest strips types with
 * esbuild without checking them, so a suite can be entirely green while the
 * code does not compile against the version it claims to use.
 *
 * Skipped when node_modules is absent (a CI checkout before install).
 */
function checkInstalledVersions(root, manifestPaths) {
  const problems = [];

  for (const path of manifestPaths) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const workspaceDir = path.slice(0, -'package.json'.length);
    const workspace = manifest.name ?? path;

    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (dependency.startsWith('@dwg/')) continue;
        const declaredMajor = majorOf(range);
        if (declaredMajor === null) continue;

        // npm hoists to the root, but a conflicting version can also be
        // nested inside the workspace. Check the nested copy first.
        const candidates = [
          join(workspaceDir, 'node_modules', dependency, 'package.json'),
          join(root, 'node_modules', dependency, 'package.json'),
        ];
        const found = candidates.find((candidate) => existsSync(candidate));
        if (found === undefined) continue; // not installed; npm ci/install will report it

        const installedVersion = JSON.parse(readFileSync(found, 'utf8')).version;
        const installedMajor = majorOf(installedVersion);
        if (installedMajor !== null && installedMajor !== declaredMajor) {
          problems.push(
            `  ${dependency}: ${workspace} declares ${range} (major ${declaredMajor}) but ${installedVersion} is installed`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error('Installed versions do not match declared ranges:\n');
    for (const problem of problems) console.error(problem);
    console.error(
      '\nThe manifests and node_modules disagree, so tests are exercising a different\n' +
        'version than the code claims to use. This usually means `npm install` failed\n' +
        '(check for an ERESOLVE peer conflict) or was never re-run after a change.\n' +
        'Run `npm install`, confirm it succeeds, then re-run the checks.',
    );
    return false;
  }
  return true;
}

/**
 * The second half of this gate, added 2026-08-23 after the *same class* of
 * failure recurred in a shape the declaration comparison above cannot see.
 *
 * That comparison only looks at what workspaces *declare*. This skew came
 * from a peer dependency: the root declared `vite@^6`, `apps/web` declared
 * no vite at all, and `@vitejs/plugin-react@6` peers on `vite@^8` — so npm
 * quietly installed a nested Vite 8 inside `apps/web` and built the SPA
 * with it, while every declaration in the repository said 6. Nothing
 * compared two declarations, because there was only one.
 *
 * This file's own header used to explain that `npm ls` was not run because
 * its output is "noisy enough to be ignored". That was true of a tree that
 * had unresolved problems in it; it is not an argument against running it
 * once the tree is clean. And the cost of not running it was concrete: the
 * lockfile was missing `@standard-schema/spec` entirely, `npm ls` exited 1,
 * and CI's SBOM step — and therefore the licence gate that consumes it —
 * had never once produced output.
 *
 * So: run it, fail on it, and print npm's own diagnosis rather than
 * paraphrasing it.
 *
 * **One declaration exists solely to keep this check honest**, and it is
 * worth knowing about before someone deletes it as unused:
 * `apps/web` declares `ajv-formats@^2.1.1` and imports it nowhere.
 * `@hookform/resolvers` (which apps/web does use, for `zodResolver`)
 * declares roughly two dozen *optional* peer dependencies, one per
 * validation library it can adapt — `ajv-formats@^2.1.1` among them. The
 * root tree carries `ajv-formats@3` for Fastify's ajv compiler, npm
 * matches that hoisted copy against the optional peer's range, and
 * reports it invalid even though nothing imports it. Declaring a
 * satisfying copy inside the workspace resolves the peer locally and
 * leaves the root copy to Fastify. The alternative was an allowlist of
 * "expected" npm complaints, and an exception list is where a gate like
 * this quietly rots.
 */
function checkTreeIntegrity(root) {
  try {
    execFileSync('npm', ['ls', '--all', '--json'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    return true;
  } catch (error) {
    const detail = (error.stderr ?? '').trim();
    console.error('Dependency tree integrity check failed (`npm ls --all`):\n');
    console.error(detail || String(error.message));
    console.error(
      '\nnpm reports the installed tree does not match what the manifests and the\n' +
        'lockfile ask for. "invalid" means an installed version does not satisfy a\n' +
        'declared range; "missing" means the lockfile has no entry for something a\n' +
        'dependency requires. Either way `npm ci` reproduces it exactly, so CI is\n' +
        'installing the same broken tree — and `@cyclonedx/cyclonedx-npm` refuses to\n' +
        'generate an SBOM from it, which silently disables the licence gate.\n\n' +
        'Usual fix: correct the declarations, delete node_modules and\n' +
        'package-lock.json, reinstall, then re-run the full suite.',
    );
    return false;
  }
}

function main() {
  const root = process.cwd();
  const declarations = new Map(); // package name -> Map<major, string[] workspaces>

  const manifestPaths = findPackageJsonPaths(root);

  for (const path of manifestPaths) {
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
    if (!checkInstalledVersions(root, manifestPaths)) {
      process.exit(1);
    }
    // Run last: it is the slowest of the three and the only one that shells
    // out, and there is no point asking npm to audit a tree whose
    // declarations are already known to disagree.
    if (!checkTreeIntegrity(root)) {
      process.exit(1);
    }
    console.log(
      `Checked ${declarations.size} distinct dependencies across workspaces: ` +
        'declarations agree, installed versions match them, and npm reports no ' +
        'invalid or missing packages in the tree.',
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
