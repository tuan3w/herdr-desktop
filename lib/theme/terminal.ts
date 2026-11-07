import { contrast, oklchToLinear, parseOklch } from "#lib/theme/color";

/** The contrast every terminal text slot reaches on `term-bg` (WCAG 2 body text), except `TERM_REMAPPED`. */
export const TERM_MIN_CONTRAST = 4.5;

/**
 * The ANSI slots a pane component remaps at render time, per appearance. Black and bright black on a dark pane (white and
 * bright white on a light one) keep their true tone because a terminal also uses them as fills; text in them is moved
 * to the nearest passing colour when drawn.
 */
export const TERM_REMAPPED = { dark: [0, 8], light: [7, 15] } as const;

const round = (x: number) => Math.round(x * 1000) / 1000;
const o = (l: number, c: number, h: number) => `oklch(${round(l)} ${round(c)} ${round(h)})`;

/** Hues of the six ANSI colours, slots 1 to 6 and, bright, 9 to 14: red, green, yellow, blue, magenta, cyan. */
const ANSI_HUES = [27, 148, 92, 255, 330, 200] as const;
/** The search aims above 4.5 so the renderer's own rounding cannot drop a colour under it. */
const AIM = 4.7;

/**
 * Moves `l` away from the ground (darker on a light pane, lighter on a dark one) until the colour reaches `AIM`
 * against `bg`, keeping chroma and hue. A colour that already passes is returned as given.
 */
function legible(l: number, c: number, h: number, bg: string, dark: boolean): string {
  const ground = oklchToLinear(parseOklch(bg));
  const step = dark ? 0.005 : -0.005;
  let lightness = l;
  while (lightness > 0.05 && lightness < 0.99 && contrast(oklchToLinear(parseOklch(o(lightness, c, h))), ground) < AIM)
    lightness += step;
  return o(lightness, c, h);
}

/**
 * The 18 terminal tokens of one appearance: `term-bg`, `term-fg` and `term-0` to `term-15` in ANSI order (eight normal,
 * eight bright). The pane's ground is a shade off the page, so a terminal reads as one surface.
 */
export function terminalTokens(
  ink: { hue: number },
  paper: { hue: number; chroma: number },
  appearance: "light" | "dark",
): Record<string, string> {
  const dark = appearance === "dark";
  const bg = dark ? o(0.185, 0.004 + paper.chroma * 0.3, ink.hue) : o(0.982, paper.chroma * 0.8, paper.hue);
  const fg = dark ? o(0.9, 0.004, ink.hue) : o(0.3, 0.008 + paper.chroma * 0.5, ink.hue);
  const text = (l: number, c: number, h: number) => legible(l, c, h, bg, dark);
  const tone = (l: number) => o(l, 0.01, ink.hue);
  // Slots 0 and 8 (black, bright black) then 7 and 15 (white, bright white): the ends that are a fill on the opposite pane.
  const ends = dark
    ? [tone(0.14), text(0.82, 0.01, ink.hue), tone(0.42), text(0.97, 0.004, ink.hue)]
    : [text(0.28, 0.01, ink.hue), tone(0.86), text(0.5, 0.01, ink.hue), tone(1)];
  const slots = [
    ends[0],
    ...ANSI_HUES.map((h) => text(dark ? 0.7 : 0.42, 0.16, h)),
    ends[1],
    ends[2],
    ...ANSI_HUES.map((h) => text(dark ? 0.82 : 0.55, 0.17, h)),
    ends[3],
  ];
  return { "term-bg": bg, "term-fg": fg, ...Object.fromEntries(slots.map((color, slot) => [`term-${slot}`, color])) };
}
