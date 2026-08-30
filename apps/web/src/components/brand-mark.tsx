import brandLogoUrl from '@/assets/brand-logo.png';
import { cn } from '@/lib/cn';

export interface BrandMarkProps {
  /**
   * Sizing/spacing for the plate — pass a size utility (e.g. `size-8`).
   * The logo fills the plate minus a proportional inset.
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
 * The mark sits on a fixed light plate rather than directly on the app
 * surface. That is deliberate, not decoration: the logo's envelope lines
 * are transparent cut-outs, so on a dark surface they would flip from
 * white to dark and the mark would read inverted from one theme to the
 * next. The plate keeps it one crisp, intentional tile in both themes —
 * the same reason `bg-white` is fixed here while everything else goes
 * through the theme tokens (its frame, `border-border-subtle`, still
 * does). See `docs/AGENT_BRIEF.md`'s design-pass notes.
 */
export function BrandMark({ className, alt = '' }: BrandMarkProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-white shadow-sm',
        className,
      )}
    >
      {/* Percentage size (relative to the plate, unlike padding, which is
          relative to the parent) keeps the inset proportional at every
          plate size the caller picks. */}
      <img src={brandLogoUrl} alt={alt} className="size-[82%] object-contain" />
    </span>
  );
}
