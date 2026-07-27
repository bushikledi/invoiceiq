'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Theme preference: follow the system, or override it.
 *
 * Three values, not two. "Dark" and "light" are choices; `system` is the
 * absence of one, and collapsing it into a boolean loses real information —
 * a user who has chosen nothing should track their machine when it switches at
 * sunset, which a stored `false` cannot express.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'invoiceiq-theme';

/**
 * Applies the preference before React hydrates, inlined into <head>.
 *
 * Without this the first paint uses the CSS default, and a dark-mode user sees
 * a white flash on every navigation — the effect being loudest for exactly the
 * people who chose dark to avoid being flashed at.
 *
 * It reads localStorage inside a try/catch because in some privacy modes the
 * mere act of touching it throws, and an exception here would abort the script
 * and leave the page unthemed.
 */
export const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`.trim();

interface ThemeContextValue {
  preference: ThemePreference;
  /** What is actually on screen right now, with `system` already resolved. */
  resolved: 'light' | 'dark';
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Starts at `system` on both server and client so the first render matches
  // what the server produced. The stored value is read in an effect instead —
  // reading it during render would make the markup depend on a browser API the
  // server does not have, which is a hydration mismatch by construction.
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') setPreferenceState(stored);
    } catch {
      /* Storage unavailable; `system` remains the preference. */
    }

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(query.matches);

    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);

    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* The choice still applies to this session; it just will not persist. */
    }

    // Removing the attribute — rather than writing 'system' — is what hands
    // control back to the media query. The CSS keys the system rule on
    // `:not([data-theme='light'])`, so any leftover value would keep winning.
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
  }, []);

  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
