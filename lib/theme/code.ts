import { contrast, mix, oklchToLinear, parseOklch } from "#lib/theme/color";

/**
 * The code colour system: one token per kind of token the highlighter tells apart (`native/app/src/highlight/role.rs`, the
 * same names in the same order: a test on each side pins them), and the surfaces they are drawn on (the block, a marked
 * line, a diff's added and removed lines and their changed words). The builder (`build.ts`) adds them to every theme.
 *
 * The look is restrained on purpose. Code is mostly identifiers, so identifiers stay in the text colour and colour goes
 * where there is little of it: strings, numbers, types and definitions. A role that is not rare gets a tone of its own
 * family, not a hue: seven hues in all (`HUES`), the rest is lightness and chroma, which survive colour blindness. Every
 * role reaches `CODE_MIN_CONTRAST` on every surface it can sit on (`legible` moves lightness until it does), except
 * punctuation, which only needs `PUNCTUATION_MIN_CONTRAST`, because brackets read as shape.
 */

/** The roles in wire order: `Role::ALL` in Rust names them the same. */
export const CODE_ROLES = [
  "plain",
  "comment",
  "doc",
  "todo",
  "keyword",
  "control",
  "modifier",
  "operator",
  "punctuation",
  "function",
  "function-def",
  "method",
  "macro",
  "type",
  "type-builtin",
  "constant",
  "number",
  "string",
  "escape",
  "regexp",
  "interpolation",
  "property",
  "variable",
  "parameter",
  "self",
  "namespace",
  "tag",
  "attribute",
  "decorator",
  "label",
  "heading",
  "emphasis",
  "strong",
  "link",
  "markup",
  "diff-add",
  "diff-remove",
  "diff-meta",
  "error",
] as const;

export type CodeRole = (typeof CODE_ROLES)[number];

/** WCAG 2 contrast every role reaches on every code surface; the search aims a little above it so rounding cannot drop one under. */
export const CODE_MIN_CONTRAST = 4.5;
export const PUNCTUATION_MIN_CONTRAST = 3;
const AIM = 4.7;

/** Roles drawn in a heavier face (a second channel next to colour; the font ships a real Medium). */
export const CODE_MEDIUM: readonly CodeRole[] = ["function-def", "heading", "strong", "todo"];

type Slot = "ink" | "key" | "fn" | "ty" | "lit" | "num" | "red" | "mute";
/** Hues of the seven families, before a theme's tilt: ink follows the theme's own text hue. */
const HUES = { key: 305, fn: 252, ty: 195, lit: 150, num: 58, red: 22, mute: 252 } as const;

interface RoleSpec {
  slot: Slot;
  /** Hue added to the slot's. */
  turn?: number;
  /** Lightness in light and in dark appearance. */
  l: [number, number];
  /** Chroma before the theme's scale. */
  c: number;
}

const ROLES: Record<CodeRole, RoleSpec> = {
  plain: { slot: "ink", l: [0.3, 0.92], c: 0.008 },
  variable: { slot: "ink", l: [0.36, 0.86], c: 0.008 },
  parameter: { slot: "mute", l: [0.4, 0.84], c: 0.04 },
  property: { slot: "mute", l: [0.42, 0.8], c: 0.06 },
  punctuation: { slot: "ink", l: [0.56, 0.64], c: 0.006 },
  operator: { slot: "ink", l: [0.48, 0.74], c: 0.01 },
  comment: { slot: "ink", l: [0.5, 0.68], c: 0.012 },
  doc: { slot: "ty", l: [0.42, 0.88], c: 0.04 },
  todo: { slot: "num", l: [0.46, 0.84], c: 0.12 },
  keyword: { slot: "key", l: [0.5, 0.76], c: 0.13 },
  control: { slot: "key", turn: -22, l: [0.4, 0.86], c: 0.16 },
  modifier: { slot: "key", turn: 10, l: [0.52, 0.72], c: 0.07 },
  macro: { slot: "key", turn: -50, l: [0.46, 0.78], c: 0.12 },
  "function-def": { slot: "fn", l: [0.43, 0.8], c: 0.14 },
  function: { slot: "fn", l: [0.46, 0.82], c: 0.07 },
  method: { slot: "fn", turn: 34, l: [0.5, 0.78], c: 0.1 },
  type: { slot: "ty", l: [0.45, 0.8], c: 0.11 },
  "type-builtin": { slot: "ty", turn: -8, l: [0.48, 0.78], c: 0.07 },
  namespace: { slot: "ty", turn: 10, l: [0.5, 0.76], c: 0.04 },
  string: { slot: "lit", l: [0.45, 0.82], c: 0.11 },
  escape: { slot: "num", turn: -8, l: [0.44, 0.84], c: 0.15 },
  regexp: { slot: "red", turn: 330, l: [0.46, 0.8], c: 0.12 },
  interpolation: { slot: "key", turn: 20, l: [0.5, 0.76], c: 0.09 },
  number: { slot: "num", l: [0.46, 0.82], c: 0.12 },
  constant: { slot: "num", turn: -28, l: [0.46, 0.8], c: 0.12 },
  decorator: { slot: "num", turn: 28, l: [0.5, 0.78], c: 0.09 },
  label: { slot: "num", turn: 10, l: [0.5, 0.78], c: 0.07 },
  self: { slot: "key", turn: 18, l: [0.5, 0.76], c: 0.08 },
  tag: { slot: "fn", turn: -18, l: [0.45, 0.8], c: 0.12 },
  attribute: { slot: "mute", turn: -10, l: [0.46, 0.8], c: 0.07 },
  heading: { slot: "fn", l: [0.4, 0.84], c: 0.13 },
  emphasis: { slot: "ink", l: [0.3, 0.92], c: 0.008 },
  strong: { slot: "ink", l: [0.24, 0.96], c: 0.008 },
  link: { slot: "fn", turn: -8, l: [0.46, 0.8], c: 0.13 },
  markup: { slot: "ink", l: [0.5, 0.7], c: 0.01 },
  "diff-add": { slot: "lit", l: [0.44, 0.84], c: 0.12 },
  "diff-remove": { slot: "red", l: [0.46, 0.82], c: 0.15 },
  "diff-meta": { slot: "mute", l: [0.5, 0.74], c: 0.05 },
  error: { slot: "red", l: [0.46, 0.8], c: 0.17 },
};

/** How a theme tilts the families: hue shift for all of them, and a scale on every chroma (Graphite is nearly monochrome). */
const TILT: Record<string, { shift: number; chroma: number }> = {
  harbor: { shift: 0, chroma: 1 },
  container: { shift: -12, chroma: 0.95 },
  chart: { shift: 8, chroma: 1.05 },
  graphite: { shift: 0, chroma: 0.5 },
};

const round = (x: number) => Math.round(x * 1000) / 1000;
const o = (l: number, c: number, h: number, alpha?: number) => `oklch(${round(l)} ${round(c)} ${round(((h % 360) + 360) % 360)}${alpha === undefined ? "" : ` / ${alpha}`})`;
type Rgb = [number, number, number];
const linear = (css: string): Rgb => oklchToLinear(parseOklch(css));

/** The surfaces a role is drawn on, as opaque colours over the block's ground: text must reach its ratio on each. */
export function codeSurfaces(tokens: Record<string, string>): Record<string, Rgb> {
  const ground = linear(tokens["code-bg"]);
  const over = (name: string): Rgb => {
    const c = parseOklch(tokens[name]);
    return mix(oklchToLinear(c), ground, c.a);
  };
  return {
    block: ground,
    line: over("code-line-bg"),
    add: over("code-add-bg"),
    remove: over("code-remove-bg"),
    hunk: over("code-hunk-bg"),
    // A changed word is tinted over its line's tint.
    addWord: mix(oklchToLinear(parseOklch(tokens["code-add-word"])), over("code-add-bg"), parseOklch(tokens["code-add-word"]).a),
    removeWord: mix(oklchToLinear(parseOklch(tokens["code-remove-word"])), over("code-remove-bg"), parseOklch(tokens["code-remove-word"]).a),
  };
}

/** Moves lightness away from the ground until `color` reaches `AIM` on every surface, keeping chroma and hue. */
function legible(l: number, c: number, h: number, surfaces: Rgb[], dark: boolean, aim: number): string {
  const step = dark ? 0.004 : -0.004;
  let lightness = l;
  const fails = (x: number) => surfaces.some((s) => contrast(linear(o(x, c, h)), s) < aim);
  while (lightness > 0.05 && lightness < 0.99 && fails(lightness)) lightness += step;
  return o(lightness, c, h);
}

/** The code tokens of one appearance: `code-bg` and the other surfaces, then `code-<role>` for every role. */
export function codeTokens(spec: { id: string; paper: { hue: number; chroma: number }; ink: { hue: number } }, appearance: "light" | "dark"): Record<string, string> {
  const dark = appearance === "dark";
  const { paper, ink } = spec;
  const tilt = TILT[spec.id] ?? { shift: 0, chroma: 1 };
  const hue = (slot: Slot, turn = 0) => (slot === "ink" ? ink.hue : HUES[slot] + tilt.shift) + turn;
  const surfaces: Record<string, string> = {
    // One small step off the chat's page: a shade darker than white, a shade deeper than charcoal.
    "code-bg": dark ? o(0.175, 0.004 + paper.chroma * 0.3, ink.hue) : o(0.972, paper.chroma * 0.8, paper.hue),
    // What a `file:line` reference points at: the text's own colour, faint.
    "code-line-bg": dark ? o(0.9, 0.01, ink.hue, 0.05) : o(0.3, 0.02, ink.hue, 0.06),
    // Added and removed lines and their changed words: tint only (the +/- column and the bar say it too).
    // In dark the tint is a mid colour (a light one over charcoal would lift the ground and cost every role its ratio).
    "code-add-bg": dark ? o(0.52, 0.13, HUES.lit + tilt.shift, 0.14) : o(0.7, 0.14, HUES.lit + tilt.shift, 0.14),
    "code-add-word": dark ? o(0.52, 0.13, HUES.lit + tilt.shift, 0.2) : o(0.7, 0.14, HUES.lit + tilt.shift, 0.26),
    "code-remove-bg": dark ? o(0.52, 0.16, HUES.red + tilt.shift, 0.15) : o(0.66, 0.17, HUES.red + tilt.shift, 0.12),
    "code-remove-word": dark ? o(0.52, 0.16, HUES.red + tilt.shift, 0.22) : o(0.66, 0.17, HUES.red + tilt.shift, 0.24),
    "code-hunk-bg": dark ? o(0.52, 0.1, HUES.fn + tilt.shift, 0.1) : o(0.7, 0.1, HUES.fn + tilt.shift, 0.09),
  };
  const grounds = Object.values(codeSurfaces(surfaces));
  const out: Record<string, string> = { ...surfaces };
  for (const role of CODE_ROLES) {
    const s = ROLES[role];
    const aim = role === "punctuation" ? PUNCTUATION_MIN_CONTRAST + 0.2 : AIM;
    out[`code-${role}`] = legible(s.l[dark ? 1 : 0], s.c * tilt.chroma, hue(s.slot, s.turn ?? 0), grounds, dark, aim);
  }
  // Line numbers are text and are read less than code: quiet, but not under the ratio. Whitespace marks are shapes.
  out["code-gutter"] = legible(dark ? 0.62 : 0.54, 0.01, ink.hue, grounds, dark, AIM);
  out["code-whitespace"] = legible(dark ? 0.5 : 0.7, 0.01, ink.hue, [grounds[0]], dark, 3.1);
  out["code-border"] = dark ? o(1, 0, 0, 0.08) : o(0.3, 0.01, ink.hue, 0.1);
  return out;
}
