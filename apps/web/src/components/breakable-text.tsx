import { Fragment } from 'react';

/**
 * Renders an identifier — an email address, a domain, a DNS record name, an
 * `UNDERSCORE_SYMBOL` — with `<wbr>` break opportunities after its natural
 * separators, so a narrow cell wraps it at `@`, `.`, `_` or `-` rather than
 * mid-label. Pair it with `break-words` (overflow-wrap: break-word), which
 * only splits inside a label when a single label is wider than the box and,
 * unlike `[overflow-wrap:anywhere]`, does not shrink the element's
 * min-content width to one character — the cause of ordinary addresses
 * breaking as `example|.com` in tables and flex rows.
 *
 * `<wbr>` adds no characters, so copying the rendered text is unchanged.
 */
export function BreakableText({
  text,
  separators = '@._-',
}: {
  readonly text: string;
  /** Characters after which a line may break. */
  readonly separators?: string;
}) {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (separators.includes(text[index]!) && index < text.length - 1) {
      parts.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  if (parts.length === 1) return text;

  return (
    <>
      {parts.map((part, index) => (
        // Index keys are stable here: the parts are a pure function of `text`.
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}
