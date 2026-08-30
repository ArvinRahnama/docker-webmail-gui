import brandLogoUrl from '@/assets/brand-logo.png';
import { cn } from '@/lib/cn';

export interface BrandMarkProps {
  /**
   * Sizing/spacing for the mark — pass a height utility (e.g. `h-9`); the
   * width follows the logo's own aspect ratio.
   */
  readonly className?: string;
  /**
   * Alt text. Defaults to `''` (decorative), which is correct wherever a
   * visible wordmark or heading already names the product — the mark is
   * then a second, redundant signal, not the only one. Pass real text
   * only when the mark stands alone.
   */
  readonly alt?: string;
}

/**
 * The project's brand mark: a Docker whale whose hull is an envelope
 * ("Docker + webmail"), from `src/assets/brand-logo.png` (a trimmed,
 * optimised derivative of `public/logo.png`, imported so Vite fingerprints
 * it and serves it same-origin under the CSP's `img-src 'self'`).
 *
 * Rendered directly, with no backing plate: the logo's envelope lines are
 * solid white pixels sitting on the blue mark (not transparent cut-outs),
 * so it reads correctly on both the light and dark surfaces — the white
 * lines are on the blue body, never on the page background. Verified by
 * screenshot in both themes.
 */
export function BrandMark({ className, alt = '' }: BrandMarkProps) {
  return (
    <img
      src={brandLogoUrl}
      alt={alt}
      className={cn('block w-auto shrink-0 object-contain', className)}
    />
  );
}
