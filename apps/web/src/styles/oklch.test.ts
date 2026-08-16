// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { contrastRatio, oklchToRgb255, relativeLuminance } from './oklch';

describe('oklchToRgb255', () => {
  it('converts OKLCH white to sRGB white', () => {
    expect(oklchToRgb255({ l: 1, c: 0, h: 0 })).toEqual([255, 255, 255]);
  });

  it('converts OKLCH black to sRGB black', () => {
    expect(oklchToRgb255({ l: 0, c: 0, h: 0 })).toEqual([0, 0, 0]);
  });

  it('converts a chroma-0 mid grey to an achromatic RGB triple', () => {
    const [r, g, b] = oklchToRgb255({ l: 0.5, c: 0, h: 0 });
    expect(r).toBe(g);
    expect(g).toBe(b);
    // Not equal to naive 0.5*255 — OKLCH lightness is perceptual, not
    // linear sRGB — but it should land in a plausible mid-grey band.
    expect(r).toBeGreaterThan(80);
    expect(r).toBeLessThan(140);
  });

  it('converts a saturated warm hue to a dominant-red triple', () => {
    const [r, g, b] = oklchToRgb255({ l: 0.63, c: 0.26, h: 29 });
    expect(r).toBeGreaterThan(200);
    expect(r).toBeGreaterThan(g + 100);
    expect(r).toBeGreaterThan(b + 100);
  });
});

describe('relativeLuminance', () => {
  it('is 1 for white and 0 for black', () => {
    expect(relativeLuminance({ l: 1, c: 0, h: 0 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ l: 0, c: 0, h: 0 })).toBeCloseTo(0, 5);
  });

  it('increases monotonically with OKLCH lightness at fixed chroma/hue', () => {
    const luminances = [0.1, 0.3, 0.5, 0.7, 0.9].map((l) =>
      relativeLuminance({ l, c: 0.01, h: 265 }),
    );
    for (let i = 1; i < luminances.length; i += 1) {
      expect(luminances[i]).toBeGreaterThan(luminances[i - 1]!);
    }
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for pure black against pure white (the WCAG maximum)', () => {
    expect(contrastRatio({ l: 1, c: 0, h: 0 }, { l: 0, c: 0, h: 0 })).toBeCloseTo(21, 0);
  });

  it('is 1:1 for a color against itself', () => {
    const color = { l: 0.6, c: 0.05, h: 200 };
    expect(contrastRatio(color, color)).toBeCloseTo(1, 5);
  });

  it('is symmetric regardless of argument order', () => {
    const a = { l: 0.9, c: 0.02, h: 100 };
    const b = { l: 0.3, c: 0.1, h: 30 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});
