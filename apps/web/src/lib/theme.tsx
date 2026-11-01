import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useUiStore, type ThemePreference, type ThemeStyle } from "./uiStore";

export type { ThemePreference, ThemeStyle };
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  theme: ThemePreference;
  resolved: ResolvedTheme;
  setTheme: (t: ThemePreference) => void;
  style: ThemeStyle;
  setStyle: (s: ThemeStyle) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefers(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// The --background of each style/mode (src/theme/*.css), for the browser
// chrome. Must match the theme-color values in index.html.
const THEME_COLOR: Record<ThemeStyle, Record<ResolvedTheme, string>> = {
  flat: { dark: "#0d1117", light: "#fafafa" },
  soft: { dark: "#1b2025", light: "#edf0f4" },
  brutal: { dark: "#050d1c", light: "#ebf7ff" },
};

function applyTheme(resolved: ResolvedTheme, style: ThemeStyle) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  // Flat is the base token set, so it carries no attribute.
  if (style === "flat") delete root.dataset.style;
  else root.dataset.style = style;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[style][resolved]);
}

// The persisted theme preference lives in the Zustand UI store; this provider
// owns only the derived/ephemeral pieces: resolving "system" against the live
// OS preference and applying the result to the document.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const style = useUiStore((s) => s.themeStyle);
  const setStyle = useUiStore((s) => s.setThemeStyle);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => systemPrefers());

  const resolved: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Track OS-level preference changes so "system" mode follows them live.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyTheme(resolved, style);
  }, [resolved, style]);

  const value = useMemo(
    () => ({ theme, resolved, setTheme, style, setStyle }),
    [theme, resolved, setTheme, style, setStyle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
