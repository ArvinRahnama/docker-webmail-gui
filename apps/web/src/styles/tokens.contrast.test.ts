// @vitest-environment node
/**
 * UX_ARCHITECTURE.md §3.4 — contrast is enforced, not asserted: this suite
 * parses tokens.css itself (not a hand-copied snapshot of it), converts
 * every OKLCH pairing to WCAG 2.1 contrast, and fails on violation. Editing
 * a lightness value in tokens.css and forgetting to re-check it is exactly
 * the drift this suite exists to catch — there's no second source of truth
 * it could fall out of sync with.
 *
 * Thresholds (§3.4): body text >=7.0:1 (AAA); secondary/muted text
 * >=4.5:1; status foreground on its paired background >=4.5:1; borders and
 * focus ring >=3.0:1 against adjacent surfaces; disabled text exempt from
 * the tiers above but still >=2.5:1. Both themes.
 *
 * `--border-subtle` is deliberately out of this matrix — see tokens.css's
 * file header for why (decorative row divider, not a component boundary).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, type Oklch } from './oklch';

const TOKENS_CSS_PATH = fileURLToPath(new URL('./tokens.css', import.meta.url));

// ---------------------------------------------------------------------------
// Parsing — deliberately format-sensitive (one `--name: oklch(...);`
// declaration per line, per tokens.css's own file-header contract) rather
// than a general CSS parser, so a malformed/unparsable token fails loudly
// instead of being silently skipped.
// ---------------------------------------------------------------------------

type TokenMap = ReadonlyMap<string, Oklch>;

/** Finds `startMarker`, then returns the text between its opening `{` and the matching closing `}` (brace-counting, so nested rules like the dark block's inner `:root:not(...) { }` don't confuse it). */
function extractBlock(source: string, startMarker: string): string {
  const markerIndex = source.indexOf(startMarker);
  if (markerIndex === -1) {
    throw new Error(
      `tokens.css: could not find block starting with ${JSON.stringify(startMarker)}`,
    );
  }
  const openBraceIndex = source.indexOf('{', markerIndex);
  if (openBraceIndex === -1) {
    throw new Error(`tokens.css: ${JSON.stringify(startMarker)} has no opening brace`);
  }

  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  throw new Error(`tokens.css: unterminated block starting with ${JSON.stringify(startMarker)}`);
}

const OKLCH_DECLARATION =
  /--([a-z0-9-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/gi;

function extractOklchTokens(blockText: string): TokenMap {
  const tokens = new Map<string, Oklch>();
  for (const match of blockText.matchAll(OKLCH_DECLARATION)) {
    const [, name, l, c, h] = match;
    tokens.set(name!, { l: Number(l), c: Number(c), h: Number(h) });
  }
  return tokens;
}

const tokensCssSource = readFileSync(TOKENS_CSS_PATH, 'utf8');

const lightTokens = extractOklchTokens(extractBlock(tokensCssSource, ':root {'));
const darkMediaTokens = extractOklchTokens(
  extractBlock(tokensCssSource, ":root:not([data-theme='light']) {"),
);
const darkAttrTokens = extractOklchTokens(
  extractBlock(tokensCssSource, ":root[data-theme='dark'] {"),
);

function requireToken(tokens: TokenMap, name: string, sourceLabel: string): Oklch {
  const token = tokens.get(name);
  if (!token) {
    throw new Error(`tokens.css: --${name} not found in ${sourceLabel} block`);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Sanity: the file actually has real content, and both dark blocks
// (prefers-color-scheme and [data-theme="dark"]) stayed in sync — the one
// property duplicating them for the toggle-in-both-directions requirement
// can silently violate.
// ---------------------------------------------------------------------------

describe('tokens.css structure', () => {
  it('parses a non-trivial number of OKLCH tokens per theme', () => {
    expect(lightTokens.size).toBeGreaterThanOrEqual(25);
    expect(darkMediaTokens.size).toBeGreaterThanOrEqual(25);
    expect(darkAttrTokens.size).toBeGreaterThanOrEqual(25);
  });

  it('keeps the @media(prefers-color-scheme) dark block and the [data-theme="dark"] dark block identical', () => {
    expect(darkMediaTokens.size).toBe(darkAttrTokens.size);
    for (const [name, mediaValue] of darkMediaTokens) {
      const attrValue = darkAttrTokens.get(name);
      expect(attrValue, `--${name} present in [data-theme="dark"] block`).toBeDefined();
      expect(attrValue).toEqual(mediaValue);
    }
  });
});

// ---------------------------------------------------------------------------
// Contrast matrix
// ---------------------------------------------------------------------------

interface Pairing {
  readonly theme: 'light' | 'dark';
  readonly fg: string;
  readonly bg: string;
  readonly minRatio: number;
  readonly tier: string;
}

const SURFACES = ['bg-app', 'bg-surface', 'bg-raised', 'bg-inset'] as const;
const THEMES = ['light', 'dark'] as const;
const STATUS_STATES = ['healthy', 'warning', 'critical', 'unknown', 'info', 'pending'] as const;

const pairings: Pairing[] = [];

for (const theme of THEMES) {
  // Body text: AAA, >=7:1, against the two primary page surfaces.
  for (const bg of ['bg-app', 'bg-surface'] as const) {
    pairings.push({ theme, fg: 'text-primary', bg, minRatio: 7.0, tier: 'body' });
  }

  // Secondary/muted text: >=4.5:1, named together as one bucket in §3.4.
  for (const fg of ['text-secondary', 'text-muted'] as const) {
    for (const bg of ['bg-app', 'bg-surface'] as const) {
      pairings.push({ theme, fg, bg, minRatio: 4.5, tier: 'secondary/muted' });
    }
  }

  // Disabled text: exempt from the tiers above, but still >=2.5:1.
  for (const bg of ['bg-app', 'bg-surface'] as const) {
    pairings.push({ theme, fg: 'text-disabled', bg, minRatio: 2.5, tier: 'disabled (floor)' });
  }

  // Status foreground on its own paired background: >=4.5:1, all 6 states.
  for (const state of STATUS_STATES) {
    pairings.push({
      theme,
      fg: `status-${state}-fg`,
      bg: `status-${state}-bg`,
      minRatio: 4.5,
      tier: 'status fg/bg',
    });
  }

  // Interactive text on the accent fill (primary button label): treated as
  // the same "foreground on its paired background" tier as status chips —
  // not literally named in §3.4's bucket list, but the same kind of
  // pairing and one that genuinely ships (Button's default variant).
  pairings.push({ theme, fg: 'accent-fg', bg: 'accent', minRatio: 4.5, tier: 'interactive fg/bg' });

  // Accent text on its own subtle background — the active nav link
  // (app-layout.tsx), badge.tsx's accent variant, sieve-scripts-page.tsx.
  // Added in M12 after a real-browser axe sweep
  // (e2e/security/accessibility.spec.ts) found this exact pairing
  // failing in light mode at the token values then in tokens.css — this
  // suite's own pairing list had never included it. Same tier as the one
  // above: real foreground on its real paired background, >=4.5:1.
  pairings.push({
    theme,
    fg: 'accent',
    bg: 'accent-subtle-bg',
    minRatio: 4.5,
    tier: 'interactive fg/bg',
  });

  // Borders and focus ring: >=3.0:1 against every adjacent surface a card,
  // input or popover can actually sit on. --border-subtle is intentionally
  // excluded — see tokens.css's file header.
  for (const fg of ['border-default', 'border-strong', 'focus-ring'] as const) {
    for (const bg of SURFACES) {
      pairings.push({ theme, fg, bg, minRatio: 3.0, tier: 'border/focus-ring' });
    }
  }
}

describe('contrast matrix (UX_ARCHITECTURE.md §3.4)', () => {
  for (const { theme, fg, bg, minRatio, tier } of pairings) {
    it(`[${theme}] --${fg} on --${bg} >= ${minRatio}:1 (${tier})`, () => {
      const tokens = theme === 'light' ? lightTokens : darkAttrTokens;
      const fgColor = requireToken(tokens, fg, theme);
      const bgColor = requireToken(tokens, bg, theme);
      const ratio = contrastRatio(fgColor, bgColor);
      expect(ratio).toBeGreaterThanOrEqual(minRatio);
    });
  }

  it('covers every status state in both themes (no state silently skipped)', () => {
    const statusPairings = pairings.filter((p) => p.tier === 'status fg/bg');
    expect(statusPairings).toHaveLength(STATUS_STATES.length * THEMES.length);
  });
});
