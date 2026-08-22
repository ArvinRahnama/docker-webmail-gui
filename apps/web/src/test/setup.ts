/**
 * Vitest setup (jsdom environment) — registers jest-dom's matchers and
 * polyfills the couple of browser APIs jsdom doesn't implement that this
 * app's components (and Radix's primitives underneath them) touch:
 * `matchMedia` (theme/reduced-motion detection), `ResizeObserver` and
 * `PointerEvent` capture methods (Radix's Dialog/DropdownMenu/Tooltip use
 * pointer capture for outside-click/hover handling), and `scrollIntoView`
 * (`cmdk`'s `Command` scrolls the selected item into view on every
 * selection change — M11's `command-palette.tsx`). Without these, tests
 * that merely *render* a component using them throw, unrelated to
 * whatever the test actually wants to assert.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FakeEventSource } from './fake-event-source';

afterEach(() => {
  cleanup();
  FakeEventSource.reset();
});

// A handful of suites (tokens.contrast.test.ts, oklch.test.ts) opt into the
// `node` environment per-file via a `@vitest-environment node` docblock —
// pure CSS-parsing/math, no DOM needed. This shared setup file still runs
// for them, so every browser-only polyfill below is skipped rather than
// throwing on a `window` that doesn't exist there.
if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      const mql: MediaQueryList = {
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          listeners.add(listener as (event: MediaQueryListEvent) => void);
        },
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          listeners.delete(listener as (event: MediaQueryListEvent) => void);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
      return mql;
    };
  }

  if (typeof window.ResizeObserver !== 'function') {
    class NoopResizeObserver implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = NoopResizeObserver;
  }

  // jsdom has no layout engine, so pointer capture is unimplemented; Radix
  // calls these defensively but they're a no-op without a real pointer.
  for (const method of [
    'hasPointerCapture',
    'setPointerCapture',
    'releasePointerCapture',
  ] as const) {
    if (!(method in Element.prototype)) {
      Object.defineProperty(Element.prototype, method, {
        value: () => false,
        writable: true,
      });
    }
  }

  if (typeof window.scrollTo !== 'function') {
    window.scrollTo = () => {};
  }

  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {};
  }

  // jsdom ships no `EventSource`, so a page that subscribes to a job stream
  // throws on mount and takes the whole file down with it — including tests
  // that never meant to touch the stream. The stand-in is inert: it opens
  // nothing and fires nothing until a test drives it, so rendering stays
  // free while `FakeEventSource.last` remains available to suites that do
  // want to assert on stream behaviour.
  if (typeof window.EventSource !== 'function') {
    window.EventSource = FakeEventSource as unknown as typeof EventSource;
  }
}
