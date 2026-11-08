import { codeTokens } from "#lib/theme/code";
import { oklchToHex } from "#lib/theme/color";
import { terminalTokens } from "#lib/theme/terminal";

/**
 * A theme is a handful of choices. Lightness, contrast and the role of every token are fixed by `buildTheme`, so
 * a new theme cannot make text unreadable by accident: it picks hues, chromas and the radius.
 *
 * The palette is deliberately quiet: a white page, a sidebar a shade off it, text in two greys, hairline borders.
 * Color is spent in three places only: the primary action, the signal ("needs you"), and status text.
 */
export interface ThemeSpec {
  id: string;
  name: string;
  blurb: string;
  /** The page and sidebar family: a whisper of tint over white (light) or charcoal (dark). */
  paper: { hue: number; chroma: number };
  /** Text color family (hue only: ink is always dark in light mode). */
  ink: { hue: number };
  /** Main action, checked boxes, focus ring. */
  primary: { hue: number; chroma: number };
  /** "Needs you": counts, hot badges. `lightness` above 0.6 gets dark text on it. */
  signal: { hue: number; chroma: number; lightness?: number };
  /** rem */
  radius: number;
  /** Hue overrides for status colors that would collide with the primary. */
  status?: Partial<Record<"destructive" | "success" | "warning" | "info", number>>;
  /** Candidate themes only (`candidates.ts`): rewrites the built tokens of one appearance, keeping the same keys. */
  adjust?: (tokens: Tokens, appearance: "light" | "dark") => Tokens;
}

export type Tokens = Record<string, string>;

export interface BuiltTheme {
  /** Both appearances, shared tokens, all complete: nsh applies it over its own default theme. */
  light: Tokens;
  dark: Tokens;
  shared: Tokens;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const o = (l: number, c: number, h: number, alpha?: number) =>
  `oklch(${round(l)} ${round(c)} ${round(h)}${alpha === undefined ? "" : ` / ${alpha}`})`;

export const FONT_SANS = "Inter";
export const FONT_MONO = "IBM Plex Mono";

export function buildTheme(spec: ThemeSpec): BuiltTheme {
  const { paper, ink, primary: p, signal: s } = spec;
  const hue = { destructive: 28, success: 155, warning: 68, info: 250, ...spec.status };
  const signalL = s.lightness ?? 0.66;
  const signalText = signalL > 0.6 ? o(0.2, 0.03, s.hue) : o(0.99, 0.005, s.hue);
  const text = o(0.3, 0.008 + paper.chroma * 0.5, ink.hue);

  const light: Tokens = {
    background: o(1, 0, paper.hue),
    foreground: text,
    card: o(1, 0, paper.hue),
    "card-foreground": text,
    popover: o(1, 0, paper.hue),
    "popover-foreground": text,
    primary: o(0.5, p.chroma, p.hue),
    "primary-foreground": o(0.99, 0.004, p.hue),
    secondary: o(0.965, paper.chroma, paper.hue),
    "secondary-foreground": text,
    muted: o(0.965, paper.chroma, paper.hue),
    "muted-foreground": o(0.52, 0.01 + paper.chroma * 0.5, ink.hue),
    accent: o(0.953, 0.002 + paper.chroma, paper.hue),
    "accent-foreground": text,
    destructive: o(0.52, 0.19, hue.destructive),
    border: o(0.3, 0.01, ink.hue, 0.09),
    input: o(0.3, 0.01, ink.hue, 0.16),
    ring: o(0.62, p.chroma, p.hue),
    success: o(0.5, 0.12, hue.success),
    warning: o(0.5, 0.12, hue.warning),
    info: o(0.5, 0.11, hue.info),
    signal: o(signalL, s.chroma, s.hue),
    "signal-foreground": signalText,
    sidebar: o(0.976, paper.chroma * 0.8, paper.hue),
    "sidebar-foreground": text,
    "sidebar-primary": o(signalL, s.chroma, s.hue),
    "sidebar-primary-foreground": signalText,
    "sidebar-accent": o(0.945, 0.002 + paper.chroma, paper.hue),
    "sidebar-accent-foreground": text,
    "sidebar-border": o(0.3, 0.01, ink.hue, 0.09),
    // Darker than `ring`: it also draws over the selected row's fill, where 0.62 falls to 3.0:1 or less.
    "sidebar-ring": o(0.58, p.chroma, p.hue),
    ...terminalTokens(ink, paper, "light"),
    ...codeTokens(spec, "light"),
  };

  const dark: Tokens = {
    background: o(0.205, 0.004 + paper.chroma * 0.3, ink.hue),
    foreground: o(0.93, 0.004, ink.hue),
    card: o(0.205, 0.004 + paper.chroma * 0.3, ink.hue),
    "card-foreground": o(0.93, 0.004, ink.hue),
    popover: o(0.255, 0.006 + paper.chroma * 0.3, ink.hue),
    "popover-foreground": o(0.93, 0.004, ink.hue),
    primary: o(0.76, p.chroma * 0.95, p.hue),
    "primary-foreground": o(0.2, 0.03, p.hue),
    secondary: o(0.27, 0.006 + paper.chroma * 0.3, ink.hue),
    "secondary-foreground": o(0.93, 0.004, ink.hue),
    muted: o(0.27, 0.006 + paper.chroma * 0.3, ink.hue),
    "muted-foreground": o(0.7, 0.01, ink.hue),
    accent: o(0.29, 0.006 + paper.chroma * 0.3, ink.hue),
    "accent-foreground": o(0.95, 0.004, ink.hue),
    destructive: o(0.79, 0.15, hue.destructive - 6),
    border: o(1, 0, 0, 0.09),
    input: o(1, 0, 0, 0.14),
    ring: o(0.64, p.chroma, p.hue),
    success: o(0.8, 0.14, hue.success),
    warning: o(0.87, 0.13, hue.warning + 12),
    info: o(0.8, 0.1, hue.info - 10),
    signal: o(Math.max(signalL, 0.74), s.chroma * 0.95, s.hue),
    "signal-foreground": o(0.2, 0.03, s.hue),
    sidebar: o(0.235, 0.005 + paper.chroma * 0.3, ink.hue),
    "sidebar-foreground": o(0.93, 0.004, ink.hue),
    "sidebar-primary": o(Math.max(signalL, 0.74), s.chroma * 0.95, s.hue),
    "sidebar-primary-foreground": o(0.2, 0.03, s.hue),
    "sidebar-accent": o(0.3, 0.006 + paper.chroma * 0.3, ink.hue),
    "sidebar-accent-foreground": o(0.95, 0.004, ink.hue),
    "sidebar-border": o(1, 0, 0, 0.08),
    "sidebar-ring": o(0.64, p.chroma, p.hue),
    ...terminalTokens(ink, paper, "dark"),
    ...codeTokens(spec, "dark"),
  };

  return {
    light: spec.adjust ? spec.adjust(light, "light") : light,
    dark: spec.adjust ? spec.adjust(dark, "dark") : dark,
    shared: { radius: `${spec.radius}rem`, "font-sans": FONT_SANS, "font-mono": FONT_MONO },
  };
}

/** The theme as nsh reads it: shadcn's `cssVars`. Pass the string to `uiTheme`, or write it to `theme.json`. */
export function themeFile(spec: ThemeSpec): { cssVars: { theme: Tokens; light: Tokens; dark: Tokens } } {
  const built = buildTheme(spec);
  return { cssVars: { theme: built.shared, light: built.light, dark: built.dark } };
}

/** Four colors that say what a theme looks like, as hex, for a preview. */
export function swatches(
  spec: ThemeSpec,
  appearance: "light" | "dark",
): { page: string; card: string; sidebar: string; primary: string; signal: string; ink: string } {
  const t = buildTheme(spec)[appearance];
  return {
    page: oklchToHex(t.background),
    card: oklchToHex(t.card),
    sidebar: oklchToHex(t.sidebar),
    primary: oklchToHex(t.primary),
    signal: oklchToHex(t.signal),
    ink: oklchToHex(t.foreground),
  };
}
