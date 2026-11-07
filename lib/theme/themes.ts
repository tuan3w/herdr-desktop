import type { ThemeSpec } from "./build";

/**
 * Themes, in picker order. To add one: add a spec here (hues and chromas only), run `bun scripts/gen-theme.mjs` if
 * it is the default, and `nsh test`: `theme.test.ts` checks contrast for every theme in both appearances.
 */
export const THEMES: ThemeSpec[] = [
  {
    id: "harbor",
    name: "Harbor",
    blurb: "A white page, warm grey text, harbor blue for the main button, one vermilion dot when something needs you.",
    paper: { hue: 90, chroma: 0.006 },
    ink: { hue: 90 },
    primary: { hue: 205, chroma: 0.085 },
    signal: { hue: 45, chroma: 0.17 },
    radius: 0.375,
  },
  {
    id: "container",
    name: "Container",
    blurb: "Cool steel grey, container rust red, safety yellow as the accent.",
    paper: { hue: 250, chroma: 0.006 },
    ink: { hue: 255 },
    primary: { hue: 38, chroma: 0.13 },
    signal: { hue: 95, chroma: 0.16, lightness: 0.8 },
    radius: 0.25,
  },
  {
    id: "chart",
    name: "Chart",
    blurb: "Navy for the main button, a bright red like a mark on a sea chart.",
    paper: { hue: 240, chroma: 0.008 },
    ink: { hue: 258 },
    primary: { hue: 258, chroma: 0.14 },
    signal: { hue: 350, chroma: 0.19 },
    radius: 0.375,
  },
  {
    id: "graphite",
    name: "Graphite",
    blurb: "Nearly monochrome: a graphite button and a single lime accent.",
    paper: { hue: 260, chroma: 0.003 },
    ink: { hue: 262 },
    primary: { hue: 262, chroma: 0.02 },
    signal: { hue: 125, chroma: 0.17, lightness: 0.8 },
    radius: 0.375,
  },
];

export const DEFAULT_THEME_ID = THEMES[0].id;

export function themeById(id: string): ThemeSpec {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
