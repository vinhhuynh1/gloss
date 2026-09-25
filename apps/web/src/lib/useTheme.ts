/**
 * Light / dark / follow-the-OS, persisted per browser.
 *
 * Three states rather than a boolean. "system" is the default and the one
 * most people never change, but it cannot be the *only* option: a student
 * reading in a bright room on a machine set to dark needs a way out, and a
 * boolean toggle initialised from the OS silently becomes an explicit choice
 * the first time it is touched, which then never follows the OS again.
 *
 * The attribute this writes is what styles.css reads. "system" writes no
 * attribute at all, which is what lets the `prefers-color-scheme` media query
 * apply; the explicit values write data-theme and win over it. See the token
 * block at the top of styles.css for the matching selectors.
 *
 * localStorage access is wrapped because it throws rather than returning null
 * in a browser with site data blocked, and a theme preference is never worth
 * failing a page load over.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "gloss.theme";

/** The stored preference, or "system" when there is none or it cannot be read.
 * Exported for main.tsx, which applies it before the first render. */
export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // Site data blocked or a private window; fall through to the default.
  }
  return "system";
}

/** Write the attribute styles.css keys off. Exported so main.tsx can call it
 * before first paint — doing it only from the hook's effect leaves the page
 * light for a frame, which reads as a flash on a dark-themed machine. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not persisting is survivable; the page still honours the choice.
    }
  }, []);

  return [theme, setTheme];
}
