"use client";

import * as React from "react";

import { COLOR_THEMES, DEFAULT_COLOR_THEME, type ColorThemeId } from "@/lib/theme-catalog";

/**
 * The shadcnblocks COLOR theme, kept apart from next-themes' light/dark choice.
 *
 * next-themes already owns `.dark` on <html> (shiki, Mol*, every `dark:` variant
 * read it), and one provider can only serve one hook — a second next-themes
 * instance would shadow `useTheme()` for the whole workbench. So this is a small
 * provider of its own: it writes `data-theme` on <html>, which `app/themes.css`
 * scopes every token block to, and persists the pick under its own storage key.
 */
export const COLOR_THEME_STORAGE_KEY = "gps-color-theme";

const THEME_IDS: readonly string[] = COLOR_THEMES.map((theme) => theme.id);

/** A stored value is trusted only when the catalog still lists it. */
export function resolveColorTheme(stored: string | null): ColorThemeId {
  return stored && THEME_IDS.includes(stored) ? (stored as ColorThemeId) : DEFAULT_COLOR_THEME;
}

/**
 * Runs before paint, in the served HTML, so a saved theme never flashes the
 * default one first. Deliberately tiny and dependency-free: it is inlined into
 * <body> by app/layout.tsx, exactly like next-themes' own light/dark script.
 */
export const COLOR_THEME_SCRIPT =
  `(function(){try{var ids=${JSON.stringify(THEME_IDS)};` +
  `var t=localStorage.getItem(${JSON.stringify(COLOR_THEME_STORAGE_KEY)});` +
  `if(!t||ids.indexOf(t)<0)t=${JSON.stringify(DEFAULT_COLOR_THEME)};` +
  `document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

type ColorThemeContextValue = {
  theme: ColorThemeId;
  setTheme: (theme: ColorThemeId) => void;
};

const ColorThemeContext = React.createContext<ColorThemeContextValue>({
  theme: DEFAULT_COLOR_THEME,
  setTheme: () => {},
});

export function ColorThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ColorThemeId>(DEFAULT_COLOR_THEME);

  // The inline script already applied the stored pick before paint; this only
  // brings the hook's value in line with it (and repairs an invalid stored id).
  React.useEffect(() => {
    setThemeState(resolveColorTheme(window.localStorage.getItem(COLOR_THEME_STORAGE_KEY)));
  }, []);

  const setTheme = React.useCallback((next: ColorThemeId) => {
    setThemeState(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, next);
    } catch {
      /* a private-mode storage refusal only costs persistence */
    }
  }, []);

  const value = React.useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ColorThemeContext.Provider value={value}>{children}</ColorThemeContext.Provider>;
}

export function useColorTheme(): ColorThemeContextValue {
  return React.useContext(ColorThemeContext);
}
