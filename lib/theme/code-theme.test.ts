import { expect, test } from "nsh/test";

import { buildTheme } from "#lib/theme/build";
import { CODE_MIN_CONTRAST, CODE_ROLES, codeSurfaces, PUNCTUATION_MIN_CONTRAST } from "#lib/theme/code";
import { contrast, oklchToLinear, parseOklch } from "#lib/theme/color";
import { THEMES } from "#lib/theme/themes";

const rgb = (css: string) => oklchToLinear(parseOklch(css));

/** Distance in OKLab between two colours: about 0.02 is the least a person tells apart side by side in small text. */
function distance(a: string, b: string): number {
  const lab = (css: string) => {
    const { l, c, h } = parseOklch(css);
    return [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

for (const spec of THEMES) {
  for (const appearance of ["light", "dark"] as const) {
    const tokens = buildTheme(spec)[appearance];
    const surfaces = codeSurfaces(tokens);

    test(`code theme ${spec.id} (${appearance}): every role reads on every code surface`, () => {
      const failing: string[] = [];
      for (const role of CODE_ROLES) {
        const min = role === "punctuation" ? PUNCTUATION_MIN_CONTRAST : CODE_MIN_CONTRAST;
        for (const [name, ground] of Object.entries(surfaces)) {
          const ratio = contrast(rgb(tokens[`code-${role}`]), ground);
          if (ratio < min) failing.push(`${role} on ${name}: ${ratio.toFixed(2)} < ${min}`);
        }
      }
      expect(failing).toEqual([]);
    });

    test(`code theme ${spec.id} (${appearance}): line numbers read and whitespace marks show`, () => {
      for (const ground of Object.values(surfaces))
        expect(contrast(rgb(tokens["code-gutter"]), ground)).toBeGreaterThanOrEqual(CODE_MIN_CONTRAST);
      expect(contrast(rgb(tokens["code-whitespace"]), surfaces.block)).toBeGreaterThanOrEqual(3);
    });

    test(`code theme ${spec.id} (${appearance}): roles that must be told apart differ`, () => {
      // Pairs that sit side by side in code and mean different things.
      const pairs: [string, string][] = [
        ["function-def", "function"],
        ["function", "method"],
        ["keyword", "control"],
        ["keyword", "modifier"],
        ["string", "escape"],
        ["number", "constant"],
        ["type", "type-builtin"],
        ["type", "string"],
        ["property", "variable"],
        ["comment", "doc"],
        ["diff-add", "diff-remove"],
        ["plain", "comment"],
        ["plain", "punctuation"],
      ];
      // Graphite is nearly monochrome by design: its pairs differ in lightness only, so the floor is lower.
      const floor = spec.id === "graphite" ? 0.025 : 0.03;
      const close = pairs
        .filter(([a, b]) => distance(tokens[`code-${a}`], tokens[`code-${b}`]) < floor)
        .map(([a, b]) => `${a} / ${b}: ${distance(tokens[`code-${a}`], tokens[`code-${b}`]).toFixed(3)}`);
      expect(close).toEqual([]);
    });

    test(`code theme ${spec.id} (${appearance}): the block is a shade off the page, never the page`, () => {
      expect(tokens["code-bg"]).not.toEqual(tokens.background);
      expect(Math.abs(parseOklch(tokens["code-bg"]).l - parseOklch(tokens.background).l)).toBeLessThan(0.08);
    });
  }
}

test("the code roles are the highlighter's closed list, in its order", () => {
  expect(CODE_ROLES.length).toBe(39);
  expect(new Set(CODE_ROLES).size).toBe(39);
});
