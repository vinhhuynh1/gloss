/**
 * Theme switch for the header.
 *
 * One button that cycles rather than three that sit there: the header already
 * carries a back link, a title, two different people-counts and a sign-out,
 * and a segmented control is a lot of width for a setting most people touch
 * once. The cost is that the next state is not visible, which is what the
 * title and aria-label are for.
 *
 * System is in the cycle rather than being only an initial default — see the
 * note in lib/useTheme.ts about why a boolean toggle quietly loses it.
 */
import { useTheme, type Theme } from "../lib/useTheme";

const NEXT: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const FACE: Record<Theme, { icon: string; label: string }> = {
  system: { icon: "🖥️", label: "matching your system" },
  light: { icon: "☀️", label: "light" },
  dark: { icon: "🌙", label: "dark" },
};

export default function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = NEXT[theme];

  return (
    <button
      className="theme-toggle"
      onClick={() => setTheme(next)}
      title={`Theme: ${FACE[theme].label} — switch to ${FACE[next].label}`}
      aria-label={`Theme: ${FACE[theme].label}. Switch to ${FACE[next].label}.`}
    >
      <span aria-hidden="true">{FACE[theme].icon}</span>
    </button>
  );
}
