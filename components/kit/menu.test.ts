import { expect, test } from "nsh/test";

import { type ItemRow, type MenuEntry, type MenuRow, menuRows } from "./menu";

const item = (rows: MenuRow[], i: number) => rows[i] as ItemRow;

test("an action closes the menu, a checkbox and a radio group leave it open", () => {
  const rows = menuRows([
    { label: "Open", onSelect: () => {} },
    { type: "checkbox", label: "Show finished sessions", checked: false, onCheckedChange: () => {} },
    { type: "radio", value: "a", onValueChange: () => {}, items: [{ value: "a", label: "A" }] },
    { type: "radio", value: "a", closeOnClick: true, onValueChange: () => {}, items: [{ value: "a", label: "A" }] },
    { type: "checkbox", label: "Pin", checked: true, closeOnClick: true, onCheckedChange: () => {} },
  ]);
  expect(rows.map((r) => (r as ItemRow).closeOnClick)).toEqual([true, false, false, true, true]);
});

test("a checkbox hands the opposite of its state to its owner, which holds the state", () => {
  const seen: boolean[] = [];
  const rows = menuRows([
    { type: "checkbox", label: "Pin", checked: false, onCheckedChange: (c) => seen.push(c) },
    { type: "checkbox", label: "Mute", checked: true, onCheckedChange: (c) => seen.push(c) },
  ]);
  item(rows, 0).select();
  item(rows, 1).select();
  expect(seen).toEqual([true, false]);
  expect(rows.map((r) => (r as ItemRow).checked)).toEqual([false, true]);
});

test("exactly the radio whose value the group holds is checked, and choosing one reports its value", () => {
  const chosen: string[] = [];
  const rows = menuRows([
    {
      type: "radio",
      label: "Status",
      value: "running",
      onValueChange: (v) => chosen.push(v),
      items: [
        { value: "queued", label: "Queued" },
        { value: "running", label: "Running" },
        { value: "done", label: "Done" },
      ],
    },
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["label", "radio", "radio", "radio"]);
  expect(rows.slice(1).map((r) => (r as ItemRow).checked)).toEqual([false, true, false]);
  item(rows, 3).select();
  expect(chosen).toEqual(["done"]);
});

test("a disabled group disables its radios, and a disabled item stays a row that can be reached", () => {
  const rows = menuRows([
    {
      type: "radio",
      value: "a",
      disabled: true,
      onValueChange: () => {},
      items: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    { label: "Delete", disabled: true, onSelect: () => {} },
  ]);
  expect(rows.map((r) => (r as ItemRow).disabled)).toEqual([true, true, true]);
  expect(rows.length).toBe(3);
});

test("a heading is a row of its own above its entries, and dividers that would dangle are dropped", () => {
  const entries: MenuEntry[] = [
    "separator",
    {
      type: "group",
      label: "Display",
      items: [{ label: "Column", onSelect: () => {} }, "separator", "separator", { label: "Row", onSelect: () => {} }],
    },
    "separator",
    "separator",
    { label: "Close", onSelect: () => {} },
    "separator",
  ];
  expect(menuRows(entries).map((r) => r.kind)).toEqual(["label", "item", "separator", "item", "separator", "item"]);
});

test("a row with items is a submenu: it is not chosen, it opens", () => {
  const rows = menuRows([{ label: "Change status", items: [{ label: "Done", onSelect: () => {} }] }]);
  expect(rows[0].kind).toBe("submenu");
});
