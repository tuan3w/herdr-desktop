import type { ThemeSpec, Tokens } from "#lib/theme/build";
import { CODE_ROLES, codeSurfaces } from "#lib/theme/code";
import { contrast, mix, oklchToLinear, parseOklch } from "#lib/theme/color";
import { TERM_REMAPPED } from "#lib/theme/terminal";

/**
 * Candidate themes (prototype, not yet the picker's final list). `buildTheme` fixes lightness (white page, charcoal
 * dark), so a theme with its own ground (cream paper, blueprint blue) states its seeds here, per appearance, as OKLCH
 * `[lightness, chroma, hue]`, and `adjust` rewrites the built tokens from them. Every text, control, signal, status, code
 * and terminal colour is then moved in lightness (never hue or chroma) until it reaches the same ratios `theme.test.ts`
 * and `code-theme.test.ts` demand on the new grounds, so a candidate cannot ship unreadable.
 */
type Lch = readonly [number, number, number];
type Rgb = [number, number, number];

interface Look {
  /** The page, and the card on it. */
  bg: Lch;
  /** Text, and the muted text of meta lines. */
  ink: Lch;
  mfg: Lch;
  /** The hairline colour (drawn at `hair[3]` alpha). */
  hair: readonly [number, number, number, number];
  /** Lightness of one layer step: the muted fill, hover fill and sidebar are multiples of it (up in dark, down in light). */
  step: number;
  primary: Lch;
  signal: Lch;
  /** Hover fill and selected-row fill when a theme wants its own (a highlighter). */
  hover?: Lch;
  select?: Lch;
  /** What `file:line` points at (the search-match and selection tint). */
  mark?: readonly [number, number, number, number];
}

interface Candidate {
  id: string;
  name: string;
  blurb: string;
  radius: number;
  status?: ThemeSpec["status"];
  light: Look;
  dark: Look;
  /** Hue and chroma the stock builder needs for its own derived tokens (code and terminal hues follow `ink`). */
  paper: { hue: number; chroma: number };
  inkHue: number;
  primary: { hue: number; chroma: number };
  signalSpec: { hue: number; chroma: number };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const o = (c: Lch, alpha?: number) =>
  `oklch(${round(c[0])} ${round(c[1])} ${round(((c[2] % 360) + 360) % 360)}${alpha === undefined ? "" : ` / ${alpha}`})`;
const lin = (c: Lch): Rgb => oklchToLinear({ l: c[0], c: c[1], h: c[2], a: 1 });
const cr = (a: Lch, b: Lch) => contrast(lin(a), lin(b));

/** Moves lightness of `c` in `dir` (+1 lighter, -1 darker) until it reaches `min` against every ground. */
function fix(c: Lch, grounds: Rgb[], min: number, dir: 1 | -1): Lch {
  let l = c[0];
  const ok = (x: number) => grounds.every((g) => contrast(lin([x, c[1], c[2]]), g) >= min);
  while (!ok(l) && l > 0.04 && l < 0.99) l += dir * 0.004;
  return [l, c[1], c[2]];
}

const parse = (css: string): Lch => {
  const p = parseOklch(css);
  return [p.l, p.c, p.h];
};

function adjustFor(c: Candidate) {
  return (t: Tokens, appearance: "light" | "dark"): Tokens => {
    const L = c[appearance];
    const dark = appearance === "dark";
    const dir = dark ? 1 : -1;
    const out: Tokens = { ...t };
    const set = (name: string, v: Lch, alpha?: number) => (out[name] = o(v, alpha));
    const off = (k: number): Lch => [L.bg[0] + dir * k * L.step, L.bg[1], L.bg[2]];

    const bg = L.bg;
    const popover = dark ? off(0.9) : bg;
    const muted = off(1);
    const accent = L.hover ?? off(1.5);
    const sidebar = off(0.6);
    const sidebarAccent = L.select ?? off(1.4);
    const grounds = [bg, popover, muted, accent, sidebar, sidebarAccent].map(lin);

    const fg = fix(L.ink, grounds, 8, dir);
    const mfg = fix(L.mfg, grounds, 4.8, dir);
    for (const [k, v] of Object.entries({
      background: bg,
      card: bg,
      popover,
      secondary: muted,
      muted,
      accent,
      sidebar,
      "sidebar-accent": sidebarAccent,
      foreground: fg,
      "card-foreground": fg,
      "popover-foreground": fg,
      "secondary-foreground": fg,
      "accent-foreground": fg,
      "sidebar-foreground": fg,
      "sidebar-accent-foreground": fg,
      "muted-foreground": mfg,
    }))
      set(k, v as Lch);
    const hair: Lch = [L.hair[0], L.hair[1], L.hair[2]];
    set("border", hair, L.hair[3]);
    set("sidebar-border", hair, L.hair[3]);
    set("input", hair, Math.min(0.5, L.hair[3] * 1.75));

    // Primary: a shape against the page (3:1) that also carries its own text (4.5:1).
    let primary: Lch = fix(L.primary, [lin(bg)], 3.2, dir);
    let pfg: Lch = [0.99, 0.004, primary[2]];
    const pickFg = () =>
      cr([0.99, 0.004, 0], primary) >= cr([0.17, 0.03, 0], primary)
        ? ([0.99, 0.004, primary[2]] as Lch)
        : ([0.17, 0.03, primary[2]] as Lch);
    for (let i = 0; i < 80; i++) {
      pfg = pickFg();
      const chip = mix(lin(primary), lin(bg), dark ? 0.1 : 0.15);
      if (cr(pfg, primary) >= 4.6 && contrast(lin(primary), chip) >= 4.6) break;
      // Away from the page's side so the 3:1 shape stays: darker in light, lighter in dark.
      primary = [primary[0] + dir * 0.01, primary[1], primary[2]];
    }
    set("primary", primary);
    set("primary-foreground", pfg);
    const ring = fix(
      [L.primary[0] + (dark ? -0.1 : 0.12), L.primary[1], L.primary[2]],
      [...grounds, lin(bg)],
      3.15,
      dir,
    );
    set("ring", ring);
    set("sidebar-ring", ring);

    // Signal: 3:1 against the page and the sidebar as a shape, 4.5:1 for its own text; the lightness scan picks the
    // nearest window where both hold (it is narrow for a light signal on a light page).
    const base = L.signal;
    let sig: Lch = base;
    let sfg: Lch = [0.17, 0.03, base[2]];
    for (let d = 0; d < 0.5; d += 0.004) {
      const found = [base[0] + d, base[0] - d].find((x) => {
        const cand: Lch = [x, base[1], base[2]];
        const need = [lin(bg), lin(sidebar)];
        if (!need.every((g) => contrast(lin(cand), g) >= 3.05)) return false;
        const dk: Lch = [0.17, 0.03, base[2]];
        const lt: Lch = [0.99, 0.005, base[2]];
        return cr(cand, dk) >= 4.55 || cr(cand, lt) >= 4.55;
      });
      if (found !== undefined) {
        sig = [found, base[1], base[2]];
        sfg = cr(sig, [0.17, 0.03, base[2]]) >= 4.55 ? [0.17, 0.03, base[2]] : [0.99, 0.005, base[2]];
        break;
      }
    }
    set("signal", sig);
    set("signal-foreground", sfg);
    set("sidebar-primary", sig);
    set("sidebar-primary-foreground", sfg);

    // Status text: 4.5:1 on the page and on its own tint over the card (the `Pill`).
    const tintAlpha: Record<string, [number, number]> = {
      destructive: [0.15, 0.1],
      success: [0.15, 0.1],
      warning: [0.2, 0.12],
      info: [0.15, 0.1],
    };
    for (const name of ["destructive", "success", "warning", "info"] as const) {
      const [al, ad] = tintAlpha[name];
      const alpha = dark ? ad : al;
      let col = parse(t[name]);
      for (let i = 0; i < 200; i++) {
        const under = mix(lin(col), lin(bg), alpha);
        if (contrast(lin(col), lin(bg)) >= 4.7 && contrast(lin(col), under) >= 4.7) break;
        col = [col[0] + dir * 0.004, col[1], col[2]];
      }
      set(name, col);
    }

    // Code: the block sits one step off the page; every role is moved until it reads on every code surface.
    const codeBg: Lch = off(dark ? -0.7 : 0.75);
    set("code-bg", codeBg);
    if (L.mark) set("code-line-bg", [L.mark[0], L.mark[1], L.mark[2]], L.mark[3]);
    set("code-border", hair, L.hair[3]);
    const surfaces = Object.values(codeSurfaces(out));
    for (const role of CODE_ROLES) {
      const key = `code-${role}`;
      out[key] = o(fix(parse(out[key]), surfaces, role === "punctuation" ? 3.2 : 4.7, dir));
    }
    out["code-gutter"] = o(fix(parse(out["code-gutter"]), surfaces, 4.7, dir));
    out["code-whitespace"] = o(fix(parse(out["code-whitespace"]), [surfaces[0]], 3.1, dir));

    // Terminal: a shade off the page like the stock pane; slots other than the remapped ends reach 4.7:1.
    const termBg: Lch = dark ? [bg[0] - 0.025, bg[1], bg[2]] : off(0.5);
    set("term-bg", termBg);
    set("term-fg", fix(fg, [lin(termBg)], 8, dir));
    const remapped: readonly number[] = TERM_REMAPPED[appearance];
    for (let slot = 0; slot < 16; slot++) {
      if (remapped.includes(slot)) continue;
      out[`term-${slot}`] = o(fix(parse(out[`term-${slot}`]), [lin(termBg)], 4.7, dir));
    }
    return out;
  };
}

const CANDIDATE_DATA: Candidate[] = [
  {
    id: "paper",
    name: "Paper",
    blurb:
      "Warm cream paper, ink with a warm bias, ruled hairlines, a red pencil for what needs you. Night paper in dark.",
    radius: 0.125,
    status: { destructive: 8, success: 150, warning: 75, info: 245 },
    paper: { hue: 85, chroma: 0.012 },
    inkHue: 65,
    primary: { hue: 60, chroma: 0.02 },
    signalSpec: { hue: 30, chroma: 0.15 },
    light: {
      bg: [0.968, 0.018, 88],
      ink: [0.25, 0.012, 65],
      mfg: [0.46, 0.02, 70],
      hair: [0.32, 0.03, 70, 0.14],
      step: 0.027,
      primary: [0.32, 0.03, 62],
      signal: [0.55, 0.15, 30],
    },
    dark: {
      bg: [0.215, 0.012, 65],
      ink: [0.9, 0.03, 85],
      mfg: [0.7, 0.02, 80],
      hair: [0.95, 0.03, 85, 0.1],
      step: 0.035,
      primary: [0.86, 0.045, 85],
      signal: [0.68, 0.14, 30],
    },
  },
  {
    id: "pencil",
    name: "Pencil",
    blurb: "Graphite on white, nearly monochrome; a highlighter marks what is selected. Chalk on slate in dark.",
    radius: 0.25,
    status: { destructive: 20, success: 155, warning: 80, info: 250 },
    paper: { hue: 260, chroma: 0.002 },
    inkHue: 260,
    primary: { hue: 260, chroma: 0.005 },
    signalSpec: { hue: 42, chroma: 0.2 },
    light: {
      bg: [0.995, 0.002, 95],
      ink: [0.27, 0.005, 260],
      mfg: [0.48, 0.006, 260],
      hair: [0.3, 0.006, 260, 0.11],
      step: 0.028,
      primary: [0.36, 0.006, 260],
      signal: [0.63, 0.2, 40],
      hover: [0.95, 0.003, 260],
      select: [0.925, 0.085, 100],
      mark: [0.88, 0.13, 100, 0.55],
    },
    dark: {
      bg: [0.245, 0.014, 215],
      ink: [0.93, 0.006, 100],
      mfg: [0.74, 0.01, 200],
      hair: [0.95, 0.01, 100, 0.11],
      step: 0.035,
      primary: [0.9, 0.008, 100],
      signal: [0.72, 0.17, 45],
      select: [0.38, 0.065, 100],
      mark: [0.6, 0.1, 100, 0.3],
    },
  },
  {
    id: "fieldnotes",
    name: "Field notes",
    blurb: "Manila paper, blue-black fountain-pen ink, a ledger green, a red stamp. Brown-black leather in dark.",
    radius: 0.25,
    status: { destructive: 20, success: 150, warning: 70, info: 250 },
    paper: { hue: 85, chroma: 0.02 },
    inkHue: 262,
    primary: { hue: 262, chroma: 0.08 },
    signalSpec: { hue: 27, chroma: 0.19 },
    light: {
      bg: [0.935, 0.04, 88],
      ink: [0.26, 0.05, 265],
      mfg: [0.44, 0.045, 255],
      hair: [0.3, 0.05, 80, 0.16],
      step: 0.03,
      primary: [0.34, 0.09, 262],
      signal: [0.54, 0.19, 27],
    },
    dark: {
      bg: [0.205, 0.022, 55],
      ink: [0.9, 0.04, 85],
      mfg: [0.72, 0.045, 80],
      hair: [0.9, 0.05, 80, 0.11],
      step: 0.035,
      primary: [0.82, 0.08, 85],
      signal: [0.68, 0.17, 27],
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    blurb: "Drafting-blue paper with navy ink lines; deep blueprint blue with white-blue lines and an amber signal.",
    radius: 0.0625,
    status: { destructive: 20, success: 160, warning: 75, info: 225 },
    paper: { hue: 238, chroma: 0.025 },
    inkHue: 258,
    primary: { hue: 258, chroma: 0.12 },
    signalSpec: { hue: 50, chroma: 0.18 },
    light: {
      bg: [0.958, 0.025, 235],
      ink: [0.27, 0.09, 258],
      mfg: [0.45, 0.085, 255],
      hair: [0.3, 0.1, 258, 0.18],
      step: 0.03,
      primary: [0.36, 0.13, 258],
      signal: [0.64, 0.18, 50],
    },
    dark: {
      bg: [0.27, 0.085, 258],
      ink: [0.95, 0.022, 235],
      mfg: [0.8, 0.05, 240],
      hair: [0.92, 0.05, 235, 0.2],
      step: 0.03,
      primary: [0.86, 0.06, 230],
      signal: [0.82, 0.16, 80],
    },
  },
  {
    id: "slate",
    name: "Slate",
    blurb: "Cool neutral greys, one indigo accent, an orange signal.",
    radius: 0.5,
    status: { destructive: 22, success: 155, warning: 75, info: 225 },
    paper: { hue: 262, chroma: 0.004 },
    inkHue: 265,
    primary: { hue: 275, chroma: 0.19 },
    signalSpec: { hue: 48, chroma: 0.19 },
    light: {
      bg: [0.992, 0.003, 262],
      ink: [0.27, 0.02, 265],
      mfg: [0.49, 0.02, 262],
      hair: [0.3, 0.02, 265, 0.1],
      step: 0.028,
      primary: [0.5, 0.19, 275],
      signal: [0.66, 0.19, 48],
    },
    dark: {
      bg: [0.215, 0.015, 265],
      ink: [0.93, 0.008, 265],
      mfg: [0.72, 0.02, 265],
      hair: [1, 0, 0, 0.09],
      step: 0.035,
      primary: [0.74, 0.13, 280],
      signal: [0.76, 0.17, 55],
    },
  },
  {
    id: "stone",
    name: "Stone",
    blurb: "Warm stone greys, a clay primary, an amber signal; no teal anywhere.",
    radius: 0.5,
    status: { destructive: 22, success: 135, warning: 80, info: 255 },
    paper: { hue: 80, chroma: 0.006 },
    inkHue: 60,
    primary: { hue: 40, chroma: 0.12 },
    signalSpec: { hue: 75, chroma: 0.15 },
    light: {
      bg: [0.988, 0.004, 82],
      ink: [0.28, 0.01, 60],
      mfg: [0.48, 0.014, 65],
      hair: [0.3, 0.015, 65, 0.1],
      step: 0.028,
      primary: [0.52, 0.12, 40],
      signal: [0.68, 0.16, 72],
    },
    dark: {
      bg: [0.215, 0.006, 70],
      ink: [0.93, 0.008, 80],
      mfg: [0.72, 0.014, 75],
      hair: [1, 0, 0, 0.09],
      step: 0.035,
      primary: [0.74, 0.1, 45],
      signal: [0.8, 0.15, 78],
    },
  },
  {
    id: "mono",
    name: "Mono",
    blurb: "Pure zinc greys, black and white buttons, one orange signal.",
    radius: 0.375,
    status: { destructive: 22, success: 155, warning: 80, info: 250 },
    paper: { hue: 286, chroma: 0.002 },
    inkHue: 286,
    primary: { hue: 286, chroma: 0.004 },
    signalSpec: { hue: 48, chroma: 0.19 },
    light: {
      bg: [0.995, 0.001, 286],
      ink: [0.22, 0.005, 286],
      mfg: [0.49, 0.006, 286],
      hair: [0.25, 0.006, 286, 0.1],
      step: 0.028,
      primary: [0.24, 0.005, 286],
      signal: [0.65, 0.19, 48],
    },
    dark: {
      bg: [0.18, 0.004, 286],
      ink: [0.95, 0.003, 286],
      mfg: [0.72, 0.008, 286],
      hair: [1, 0, 0, 0.09],
      step: 0.035,
      primary: [0.93, 0.003, 286],
      signal: [0.74, 0.17, 52],
    },
  },
];

export const CANDIDATES: ThemeSpec[] = CANDIDATE_DATA.map((c) => ({
  id: c.id,
  name: c.name,
  blurb: c.blurb,
  paper: c.paper,
  ink: { hue: c.inkHue },
  primary: c.primary,
  signal: c.signalSpec,
  radius: c.radius,
  status: c.status,
  adjust: adjustFor(c),
}));
