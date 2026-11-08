import { expect, test } from "nsh/test";

import { chosenTitle, listWidth, selectRows, toggled } from "./select";

import type { ItemRow } from "./menu";

const same = (a: string, b: string) => a === b;
const picked: string[] = [];
const base = {
  chosen: [] as string[],
  equal: same,
  multiple: false,
  readOnly: false,
  pick: (v: string) => void picked.push(v),
};

test("a single select ticks its value and closes when an option is chosen", () => {
  picked.length = 0;
  const rows = selectRows(
    ["a", "b"].map((v) => ({ value: v, title: v.toUpperCase() })),
    { ...base, chosen: ["b"] },
  ) as ItemRow[];
  expect(rows.map((r) => r.checked)).toEqual([false, true]);
  expect(rows.every((r) => r.kind === "radio" && r.closeOnClick)).toBe(true);
  rows[0].select();
  expect(picked).toEqual(["a"]);
});

test("a multiple select ticks several and stays open", () => {
  const rows = selectRows(
    ["a", "b", "c"].map((v) => ({ value: v, title: v })),
    { ...base, multiple: true, chosen: ["a", "c"] },
  ) as ItemRow[];
  expect(rows.map((r) => r.checked)).toEqual([true, false, true]);
  expect(rows.every((r) => r.kind === "check" && !r.closeOnClick)).toBe(true);
  expect(toggled(["a", "c"], "b", same)).toEqual(["a", "c", "b"]);
  expect(toggled(["a", "c"], "a", same)).toEqual(["c"]);
});

test("a read-only select lists its options and chooses nothing, and stays open", () => {
  picked.length = 0;
  const rows = selectRows([{ value: "a", title: "A" }], { ...base, readOnly: true }) as ItemRow[];
  rows[0].select();
  expect(picked).toEqual([]);
  expect(rows[0].closeOnClick).toBe(false);
});

test("values that are the same by the caller's rule are the same option", () => {
  const rows = selectRows([{ value: "LAP", title: "Laptop" }], {
    ...base,
    chosen: ["lap"],
    equal: (a, b) => a.toLowerCase() === b.toLowerCase(),
  }) as ItemRow[];
  expect(rows[0].checked).toBe(true);
});

test("groups put a heading before their options, and a disabled option is listed but cannot be chosen", () => {
  const rows = selectRows(
    [
      {
        label: "Office",
        items: [
          { value: "lap", title: "Laptop" },
          { value: "bb", title: "Build box", disabled: true },
        ],
      },
      "separator",
      { label: "Cloud", items: [{ value: "vm", title: "Cloud VM" }] },
    ],
    base,
  );
  expect(rows.map((r) => r.kind)).toEqual(["label", "radio", "radio", "separator", "label", "radio"]);
  expect((rows[2] as ItemRow).disabled).toBe(true);
});

test("a choice list is as wide as its trigger at least, and grows to its longest option up to a limit", () => {
  // narrow trigger, short options: the floor
  expect(listWidth(["Low", "High"], 120, 1280)).toBe(176);
  // a trigger wider than the options keeps its width
  expect(listWidth(["Low"], 300, 1280)).toBe(300);
  // "4.5 (recommended)" must be read whole: 17 glyphs plus the popup's and row's chrome fit in the list
  const wide = listWidth(["4.5", "4.5 (recommended)", "4.0"], 120, 1280);
  expect(wide).toBeGreaterThanOrEqual(17 * 7 + 52);
  // a very long option stops at the limit and is cut with an ellipsis there
  expect(listWidth(["x".repeat(200)], 120, 1280)).toBe(480);
  // and never wider than the window less its margins
  expect(listWidth(["x".repeat(200)], 120, 300)).toBe(284);
  // a wide character counts twice
  expect(listWidth(["日本語日本語日本語日本語"], 100, 1280)).toBeGreaterThan(listWidth(["abcdefghijkl"], 100, 1280));
});

test("a chosen value the options no longer have is shown as itself, never as the placeholder", () => {
  const options = [
    { value: "claude", title: "Claude Code" },
    { value: "codex", title: "Codex" },
  ];
  const cases: [string[], string][] = [
    [[], ""],
    [["codex"], "Codex"],
    [["ghost-agent"], "ghost-agent"],
    // Titles in the order of the options, then what no option has.
    [["ghost-agent", "codex", "claude"], "Claude Code, Codex, ghost-agent"],
  ];
  for (const [chosen, shown] of cases) expect(chosenTitle(options, chosen, same)).toBe(shown);
});
