import { expect, open, test } from "nsh/test";
import theme from "../../theme.json";
import { buildTheme, themeFile } from "#lib/theme/build";
import { contrast, mix, oklchToHex, oklchToLinear, parseOklch } from "#lib/theme/color";
import { DEFAULT_THEME_ID, THEMES, themeById } from "#lib/theme/themes";
import { TERM_MIN_CONTRAST, TERM_REMAPPED } from "#lib/theme/terminal";

type Rgb = [number, number, number];
const rgb = (css: string, over?: Rgb): Rgb => {
  const c = parseOklch(css);
  const color = oklchToLinear(c);
  return over && c.a < 1 ? mix(color, over, c.a) : color;
};

/** Pairs that text or controls actually use, with the contrast each needs (WCAG 2: 4.5 text, 3 non-text). */
function pairs(t: Record<string, string>, dark: boolean): { name: string; ratio: number; min: number }[] {
  const page = rgb(t.background);
  const card = rgb(t.card);
  /** `Pill` tints: `bg-x/15` (warning `/20`) in light, `dark:bg-x/10` (warning `/12`) in dark. */
  const tint = (token: string, light: number, darkAlpha: number) => mix(rgb(t[token]), card, dark ? darkAlpha : light);
  const on = (fg: string, bgToken: string, min = 4.5) => ({ name: `${fg} on ${bgToken}`, ratio: contrast(rgb(t[fg]), rgb(t[bgToken])), min });
  return [
    on("foreground", "background", 7),
    on("card-foreground", "card", 7),
    on("popover-foreground", "popover", 7),
    on("muted-foreground", "background"),
    on("muted-foreground", "card"),
    on("muted-foreground", "muted"),
    on("muted-foreground", "accent"),
    on("muted-foreground", "sidebar"),
    on("muted-foreground", "sidebar-accent"),
    on("primary-foreground", "primary"),
    on("accent-foreground", "accent"),
    on("secondary-foreground", "secondary"),
    on("signal-foreground", "signal"),
    on("primary", "background", 3),
    on("ring", "background", 3),
    on("ring", "accent", 3),
    on("ring", "card", 3),
    on("ring", "popover", 3),
    // The edge of an input or a checkbox is the only thing that says "a control is here".
    on("input", "card", 3),
    on("input", "background", 3),
    on("muted-foreground", "popover"),
    on("sidebar-foreground", "sidebar"),
    on("sidebar-foreground", "sidebar-accent"),
    // The inset focus ring of a sidebar row sits on the page shade, or on the fill of a selected or hovered row.
    on("sidebar-ring", "sidebar", 3),
    on("sidebar-ring", "sidebar-accent", 3),
    on("sidebar-accent-foreground", "sidebar-accent"),
    on("sidebar-primary-foreground", "sidebar-primary"),
    // The signal badge is a shape holding text; on the light sidebar a light signal cannot also be a 3:1 shape.
    ...(dark ? [on("sidebar-primary", "sidebar", 3)] : []),
    { name: "primary on tinted primary chip", ratio: contrast(rgb(t.primary), tint("primary", 0.15, 0.1)), min: 4.5 },
    { name: "destructive on card", ratio: contrast(rgb(t.destructive), card), min: 4.5 },
    { name: "destructive on page", ratio: contrast(rgb(t.destructive), page), min: 4.5 },
    { name: "success on tint", ratio: contrast(rgb(t.success), tint("success", 0.15, 0.1)), min: 4.5 },
    { name: "warning on tint", ratio: contrast(rgb(t.warning), tint("warning", 0.2, 0.12)), min: 4.5 },
    { name: "info on tint", ratio: contrast(rgb(t.info), tint("info", 0.15, 0.1)), min: 4.5 },
    { name: "destructive on tint", ratio: contrast(rgb(t.destructive), tint("destructive", 0.15, 0.1)), min: 4.5 },
  ];
}

for (const spec of THEMES) {
  for (const appearance of ["light", "dark"] as const) {
    test(`theme ${spec.id} (${appearance}) keeps text readable`, () => {
      const tokens = buildTheme(spec)[appearance];
      const failing = pairs(tokens, appearance === "dark")
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.name}: ${p.ratio.toFixed(2)} < ${p.min}`);
      expect(failing).toEqual([]);
    });
  }
}

/** The terminal palette: text slots read on `term-bg` at 4.5:1, the default text at 7:1; the remapped slots are the dark/light ends and are the only ones allowed to fall short. */
for (const spec of THEMES) {
  for (const appearance of ["light", "dark"] as const) {
    test(`theme ${spec.id} (${appearance}) keeps terminal text readable`, () => {
      const tokens = buildTheme(spec)[appearance];
      const ground = rgb(tokens["term-bg"]);
      const remapped: readonly number[] = TERM_REMAPPED[appearance];
      const failing = Array.from({ length: 16 }, (_, slot) => ({ slot, ratio: contrast(rgb(tokens[`term-${slot}`]), ground) }))
        .filter((p) => !remapped.includes(p.slot) && p.ratio < TERM_MIN_CONTRAST)
        .map((p) => `term-${p.slot}: ${p.ratio.toFixed(2)} < ${TERM_MIN_CONTRAST}`);
      expect(failing).toEqual([]);
      expect(contrast(rgb(tokens["term-fg"]), ground)).toBeGreaterThanOrEqual(7);
    });
  }
}

test("the remapped slots are the ones that fall short, so the pane component has something to remap", () => {
  for (const spec of THEMES) {
    for (const appearance of ["light", "dark"] as const) {
      const tokens = buildTheme(spec)[appearance];
      const ground = rgb(tokens["term-bg"]);
      for (const slot of TERM_REMAPPED[appearance]) expect(contrast(rgb(tokens[`term-${slot}`]), ground)).toBeLessThan(TERM_MIN_CONTRAST);
    }
  }
});

test("every theme defines the same tokens, so switching never leaves one behind", () => {
  const names = (t: Record<string, string>) => Object.keys(t).sort();
  const first = buildTheme(THEMES[0]);
  for (const spec of THEMES) {
    const built = buildTheme(spec);
    expect(names(built.light)).toEqual(names(first.light));
    expect(names(built.dark)).toEqual(names(first.light));
    expect(names(built.shared)).toEqual(names(first.shared));
  }
});

test("theme.json is the default theme: the app starts in the theme the generator describes", () => {
  expect(theme).toEqual(themeFile(themeById(DEFAULT_THEME_ID)));
});

test("switching the theme at runtime restyles the app: token() follows every theme in both appearances", async () => {
  const hex = (css: string) => oklchToHex(css).slice(1);
  const close = (a: string, b: string) => [0, 2, 4].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 2);
  const app = await open("./probe.tsx", { width: 320, height: 400 });
  for (const appearance of ["light", "dark"] as const) {
    await app.setColorScheme(appearance);
    for (const spec of THEMES) {
      await app.press(spec.id);
      const shown = app.texts().find((t) => t.startsWith("#")) ?? "";
      const expected = hex(buildTheme(spec)[appearance].primary);
      expect(close(shown.slice(1, 7), expected)).toBe(true);
    }
  }
});
