import { expect, test } from "nsh/test";
import type { ItemRow } from "./menu";
import { selectRows, toggled } from "./select";

const same = (a: string, b: string) => a === b;
const picked: string[] = [];
const base = { chosen: [] as string[], equal: same, multiple: false, readOnly: false, pick: (v: string) => void picked.push(v) };

test("a single select ticks its value and closes when an option is chosen", () => {
  picked.length = 0;
  const rows = selectRows(["a", "b"].map((v) => ({ value: v, title: v.toUpperCase() })), { ...base, chosen: ["b"] }) as ItemRow[];
  expect(rows.map((r) => r.checked)).toEqual([false, true]);
  expect(rows.every((r) => r.kind === "radio" && r.closeOnClick)).toBe(true);
  rows[0].select();
  expect(picked).toEqual(["a"]);
});

test("a multiple select ticks several and stays open", () => {
  const rows = selectRows(["a", "b", "c"].map((v) => ({ value: v, title: v })), { ...base, multiple: true, chosen: ["a", "c"] }) as ItemRow[];
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
  const rows = selectRows([{ value: "LAP", title: "Laptop" }], { ...base, chosen: ["lap"], equal: (a, b) => a.toLowerCase() === b.toLowerCase() }) as ItemRow[];
  expect(rows[0].checked).toBe(true);
});

test("groups put a heading before their options, and a disabled option is listed but cannot be chosen", () => {
  const rows = selectRows(
    [
      { label: "Office", items: [{ value: "lap", title: "Laptop" }, { value: "bb", title: "Build box", disabled: true }] },
      "separator",
      { label: "Cloud", items: [{ value: "vm", title: "Cloud VM" }] },
    ],
    base,
  );
  expect(rows.map((r) => r.kind)).toEqual(["label", "radio", "radio", "separator", "label", "radio"]);
  expect((rows[2] as ItemRow).disabled).toBe(true);
});
