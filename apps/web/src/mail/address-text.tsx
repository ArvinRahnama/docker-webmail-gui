import { Fragment, type ReactNode } from 'react';
import { BreakableText } from '@/components/breakable-text';

/**
 * At or under this many characters an address or domain stays on one line
 * (`user1@example.com`, `example.com`): breaking it would only turn a short
 * value into a ragged two-line one, and its full width is small enough that
 * no table needs to squeeze it.
 */
const ONE_LINE_MAX_LENGTH = 20;

/**
 * A label (the text between `@ . _ -`) longer than this is effectively
 * unbroken — no real-world address or domain has one — so it may also split
 * mid-label rather than force its column, and the table, wide.
 */
const LONGEST_ORDINARY_LABEL = 24;

function hasOverlongLabel(text: string): boolean {
  return text.split(/[@._-]/).some((label) => label.length > LONGEST_ORDINARY_LABEL);
}

/**
 * Width floor for the box holding an address or domain in a table cell, or
 * `undefined` when it needs none. Auto table layout squeezes every column to
 * its min-content once the table is wider than its scroller. For a value with
 * an over-long label that min-content is one character (it may split
 * anywhere), and for a long address it is one label, stacking
 * `accounts.payable@northwind-traders.com` a label per line; both get a floor.
 * Short values never wrap, and an ordinary domain packs its labels into a
 * line or two on its own, so they get none: a floor there would only widen
 * the table (and push columns off a phone screen) without saving a line.
 * The floor is 10rem, eased to 40vw on the narrowest phones so a two-column
 * table in a card (domain detail at 320px) still fits beside it. A static
 * string so Tailwind's scanner sees the class name.
 */
export function addressFloorClassName(text: string): string | undefined {
  if (text.length <= ONE_LINE_MAX_LENGTH) return undefined;
  return text.includes('@') || hasOverlongLabel(text) ? 'min-w-[min(10rem,40vw)]' : undefined;
}

/**
 * An email address or domain in a table cell or list. Long values get `<wbr>`
 * break opportunities after `@ . _ -` (see `BreakableText`), so with
 * `break-words` on the cell they wrap at a label boundary
 * (`accounts.payable@|northwind-traders.com`) instead of mid-word; short ones
 * stay whole. Only an over-long label itself falls back to
 * `overflow-wrap: anywhere`, so the ordinary labels around it (the domain
 * after a 64-character local part) still break only at their boundaries.
 */
export function AddressText({ text }: { readonly text: string }) {
  if (text.length <= ONE_LINE_MAX_LENGTH) return text;

  // Each piece is one label plus the separator after it.
  const runs: ReactNode[] = [];
  let ordinary = '';
  const flushOrdinary = () => {
    if (!ordinary) return;
    // A final label of up to three letters (`com`, `uk`) stays with the one
    // before it: `northwind-|traders.com`, never `northwind-traders.|com`.
    const glued = /^(.*[^@._-])(\.[^@._-]{1,3})$/.exec(ordinary);
    runs.push(
      glued ? (
        <>
          <BreakableText text={glued[1]!} />
          {glued[2]}
        </>
      ) : (
        <BreakableText text={ordinary} />
      ),
    );
    ordinary = '';
  };
  for (const piece of text.match(/[^@._-]*[@._-]?/g) ?? []) {
    if (piece.replace(/[@._-]$/, '').length > LONGEST_ORDINARY_LABEL) {
      flushOrdinary();
      runs.push(<span className="wrap-anywhere">{piece}</span>);
    } else {
      ordinary += piece;
    }
  }
  flushOrdinary();

  return (
    <>
      {runs.map((run, index) => (
        // Index keys are stable: the runs are a pure function of `text`.
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {run}
        </Fragment>
      ))}
    </>
  );
}

/**
 * An alias's destinations, one per line. `withArrows` prefixes each with a
 * decorative arrow, for when the list sits under the alias address rather
 * than in its own "Destinations" column.
 */
export function AliasDestinationsList({
  recipients,
  withArrows = false,
}: {
  readonly recipients: readonly string[];
  readonly withArrows?: boolean;
}) {
  return (
    <ul className="flex flex-col text-text-secondary" aria-label="Destinations">
      {recipients.map((recipient) => (
        <li key={recipient} className={withArrows ? 'flex gap-1' : undefined}>
          {withArrows ? (
            <span aria-hidden="true" className="text-text-muted">
              →
            </span>
          ) : null}
          <span className="min-w-0">
            <AddressText text={recipient} />
          </span>
        </li>
      ))}
    </ul>
  );
}
