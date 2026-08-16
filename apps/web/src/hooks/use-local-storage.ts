import { useCallback, useEffect, useState } from 'react';

/**
 * Persisted `useState`, for the app shell's own preferences (§5.3 sidebar
 * collapsed state, §4 table density) — not for anything server-owned;
 * those go through TanStack Query, not localStorage. Reads lazily (so SSR
 * — none here, but also a Vitest/jsdom module-eval pass before a test
 * populates storage — never sees a stale value) and re-reads if `key`
 * changes.
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readStorage(key, defaultValue));

  // Only re-sync when the key itself changes — re-reading on every
  // `defaultValue` identity change would fight a caller passing an inline
  // object/array literal as the default, so `defaultValue` is
  // intentionally left out of this dependency array.
  useEffect(() => {
    setValue(readStorage(key, defaultValue));
  }, [key]);

  const setPersistedValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Private browsing / storage quota / disabled storage: the
          // preference just doesn't persist this session rather than
          // crashing the app over a non-essential feature.
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, setPersistedValue] as const;
}

function readStorage<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? defaultValue : (JSON.parse(raw) as T);
  } catch {
    return defaultValue;
  }
}
