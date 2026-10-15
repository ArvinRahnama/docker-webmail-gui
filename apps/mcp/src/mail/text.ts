/**
 * Turning untrusted email content into bounded plain text for an AI model.
 *
 * HTML is never rendered, executed, or fetched from: tags are stripped,
 * `<script>`/`<style>`/`<head>` contents dropped, entities decoded, links
 * reduced to their visible text followed by the URL in parentheses (as
 * inert text — this service never requests any URL found in a message).
 * Control characters other than newline/tab are removed so a message cannot
 * smuggle terminal escapes or bidi overrides into a transcript.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  euro: '€',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/* eslint-disable no-control-regex -- matching control characters is the point */
const UNSAFE_TEXT_CHARACTERS =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

/** Removes C0/C1 controls (except \n and \t), bidi overrides and zero-width joiners used for spoofing. */
export function stripControlCharacters(text: string): string {
  return text.replace(UNSAFE_TEXT_CHARACTERS, '');
}

export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(
    /<(script|style|head|title|template|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  text = text.replace(
    /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, _q, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      const url = href.trim();
      if (url.length === 0 || url.toLowerCase().startsWith('javascript:')) return label;
      return label.length > 0 && label !== url ? `${label} (${url})` : url;
    },
  );
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(
    /<\/(p|div|h[1-6]|li|tr|table|blockquote|pre|section|article|header|footer)\s*>/gi,
    '\n',
  );
  text = text.replace(/<li\b[^>]*>/gi, '\n\u2022 ');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text.replace(/[ \t\f\v\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return stripControlCharacters(text).trim();
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Header-ish single-line value: no CR/LF, no controls, bounded. */
export function cleanLine(value: string | null | undefined, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = stripControlCharacters(value.replace(/[\r\n]+/g, ' ')).trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}
