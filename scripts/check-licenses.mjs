#!/usr/bin/env node
/**
 * License gate.
 *
 * Reads a CycloneDX SBOM and fails if any component carries a license outside
 * the project's permissive allowlist, or a license it cannot identify.
 *
 * This implements the control promised in SECURITY.md §3.14 and
 * LICENSE_AUDIT.md §8 — "the SBOM job fails on a newly-introduced
 * non-permissive license". Generating an SBOM without checking it would leave
 * that control documented but not real.
 *
 * Unrecognised licenses fail deliberately. A license we have never classified
 * is a decision for a human, not something to wave through: the failure asks
 * someone to add it to ALLOWED (with a note in LICENSE_AUDIT.md) or to remove
 * the dependency.
 *
 * Usage: node scripts/check-licenses.mjs [path-to-sbom.cdx.json]
 */

import { readFileSync } from 'node:fs';

/**
 * Permissive licenses acceptable for this project (Apache-2.0, see
 * LICENSE_AUDIT.md). Deliberately an allowlist, not a denylist of copyleft
 * identifiers — a denylist silently passes anything it has not heard of,
 * which is the wrong default for a supply-chain gate.
 */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0', // `tar` — permissive but unusual; see LICENSE_AUDIT.md §6
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  // MPL-2.0 is *weak, file-level* copyleft: it does not infect the larger
  // work, and only modifications to MPL-licensed files must stay MPL. It
  // enters this tree solely through build tooling — lightningcss, via Vite,
  // @tailwindcss/vite and Vitest — which `npm ls --omit=dev` confirms is
  // never shipped in a runtime artifact. Accepted on that basis. If an
  // MPL-2.0 component ever appears in *runtime* dependencies, treat that as
  // a fresh decision and record it in LICENSE_AUDIT.md rather than assuming
  // this entry covers it.
  'MPL-2.0',
  'OFL-1.1', // Inter, JetBrains Mono — see NOTICE
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/**
 * Components excluded from the gate. Keep this empty unless there is a
 * documented reason, and record the reason here — an exception list is where
 * license gates quietly rot.
 */
const EXCEPTIONS = new Map([
  // ['pkg@1.2.3', 'why this is acceptable'],
]);

/** Normalise the several shapes CycloneDX uses for a license. */
function extractLicenseStrings(component) {
  const out = [];
  for (const entry of component.licenses ?? []) {
    if (entry.expression) out.push(entry.expression);
    else if (entry.license?.id) out.push(entry.license.id);
    else if (entry.license?.name) out.push(entry.license.name);
  }
  return out;
}

/**
 * Evaluate an SPDX expression against the allowlist.
 * `A OR B` passes if either side passes; `A AND B` requires both.
 * Parenthesised and nested expressions are handled by recursion.
 */
function isAllowedExpression(expression) {
  const expr = expression.trim();

  // Strip one layer of fully-enclosing parentheses.
  if (expr.startsWith('(') && expr.endsWith(')')) {
    let depth = 0;
    let enclosing = true;
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')') {
        depth--;
        if (depth === 0 && i < expr.length - 1) {
          enclosing = false;
          break;
        }
      }
    }
    if (enclosing) return isAllowedExpression(expr.slice(1, -1));
  }

  // Split on top-level OR first (lower precedence than AND in SPDX).
  for (const [operator, combine] of [
    [' OR ', (parts) => parts.some(isAllowedExpression)],
    [' AND ', (parts) => parts.every(isAllowedExpression)],
  ]) {
    const parts = splitTopLevel(expr, operator);
    if (parts.length > 1) return combine(parts);
  }

  // A bare identifier. Tolerate the "+" suffix (e.g. "Apache-2.0+").
  return ALLOWED.has(expr.replace(/\+$/, ''));
}

function splitTopLevel(expr, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') depth--;
    else if (depth === 0 && expr.startsWith(operator, i)) {
      parts.push(expr.slice(start, i));
      start = i + operator.length;
      i += operator.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function main() {
  const sbomPath = process.argv[2] ?? 'sbom.cdx.json';

  let sbom;
  try {
    sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  } catch (error) {
    console.error(`Could not read SBOM at ${sbomPath}: ${error.message}`);
    process.exit(2);
  }

  const components = sbom.components ?? [];
  if (components.length === 0) {
    console.error(`No components found in ${sbomPath}. Refusing to report a vacuous pass.`);
    process.exit(2);
  }

  const disallowed = [];
  const unknown = [];

  for (const component of components) {
    const ref = `${component.name}@${component.version ?? '?'}`;
    if (EXCEPTIONS.has(ref)) continue;

    const licenses = extractLicenseStrings(component);
    if (licenses.length === 0) {
      unknown.push({ ref, reason: 'no license metadata' });
      continue;
    }
    // A component may declare several licenses; passing any one is enough.
    if (!licenses.some(isAllowedExpression)) {
      disallowed.push({ ref, licenses: licenses.join(', ') });
    }
  }

  console.log(`Checked ${components.length} components from ${sbomPath}.`);

  if (unknown.length > 0) {
    console.error(`\n${unknown.length} component(s) with unidentified licenses:`);
    for (const { ref, reason } of unknown) console.error(`  - ${ref} (${reason})`);
  }

  if (disallowed.length > 0) {
    console.error(`\n${disallowed.length} component(s) outside the permissive allowlist:`);
    for (const { ref, licenses } of disallowed) console.error(`  - ${ref}: ${licenses}`);
  }

  if (disallowed.length > 0 || unknown.length > 0) {
    console.error(
      '\nLicense gate failed. Either remove the dependency, or — if the license is ' +
        'genuinely acceptable for an Apache-2.0 project — add it to ALLOWED in this ' +
        'script and record the decision in LICENSE_AUDIT.md.',
    );
    process.exit(1);
  }

  console.log('License gate passed: all components are permissively licensed.');
}

main();
