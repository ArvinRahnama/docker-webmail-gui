/**
 * OKLCH -> linear sRGB -> WCAG 2.1 relative luminance -> contrast ratio.
 *
 * UX_ARCHITECTURE.md §3.4: contrast is enforced by parsing the token file
 * and computing real WCAG contrast, not by hand-measuring and hoping the
 * numbers don't drift. This module is the math half of that;
 * tokens.contrast.test.ts is the parsing + assertion half.
 *
 * The OKLab <-> linear-sRGB matrices are Björn Ottosson's published
 * constants (the same ones used by the CSS Color 4 spec's own reference
 * conversions, and by culori/colorjs.io). oklch.test.ts checks this module
 * against known reference points (white, black, a neutral grey, a
 * saturated red) so a transcription error in the matrices — the one place
 * this is easy to get subtly wrong — fails loudly instead of silently
 * skewing every contrast number by a few percent.
 */

export interface Oklch {
  readonly l: number;
  readonly c: number;
  /** Hue in degrees, as written in `oklch(L C H)`. */
  readonly h: number;
}

export interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** OKLCH -> OKLab -> LMS -> linear sRGB. Output may fall slightly outside [0, 1] for out-of-gamut input; callers clamp when computing luminance. */
export function oklchToLinearSrgb(color: Oklch): LinearRgb {
  const hRad = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hRad);
  const b = color.c * Math.sin(hRad);

  const lNonlinear = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const mNonlinear = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const sNonlinear = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l = lNonlinear ** 3;
  const m = mNonlinear ** 3;
  const s = sNonlinear ** 3;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/**
 * WCAG relative luminance (the `L` in the WCAG 2.1 contrast formula).
 * Linear-light sRGB values plug directly into the standard 0.2126/0.7152/
 * 0.0722 weights — no separate gamma-decode step is needed because
 * {@link oklchToLinearSrgb} already returns linear values, not
 * gamma-encoded 0-255 ones. Negative components (possible for an
 * out-of-gamut OKLCH triple) are clamped to 0 rather than allowed to pull
 * luminance below the physically meaningful range.
 */
export function relativeLuminance(color: Oklch): number {
  const { r, g, b } = oklchToLinearSrgb(color);
  const clamp = (v: number): number => Math.max(0, v);
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/** WCAG 2.1 contrast ratio between two OKLCH colors, order-independent, in [1, 21]. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Linear sRGB -> gamma-encoded 0-255 triple. Used only by tests that want a human-readable sanity check (e.g. "does oklch(1 0 0) look like white?"), never by the contrast math itself. */
export function oklchToRgb255(color: Oklch): readonly [number, number, number] {
  const gammaEncode = (x: number): number => {
    const c = Math.max(0, Math.min(1, x));
    return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  const { r, g, b } = oklchToLinearSrgb(color);
  return [
    Math.round(gammaEncode(r) * 255),
    Math.round(gammaEncode(g) * 255),
    Math.round(gammaEncode(b) * 255),
  ];
}
