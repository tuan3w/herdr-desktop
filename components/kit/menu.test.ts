import { expect, test } from "nsh/test";

import {
  fitRows,
  type ItemRow,
  type MenuEntry,
  type MenuRow,
  menuRows,
  menuWidth,
  roomAround,
  rowTone,
  snapScroll,
} from "./menu";

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

// 12 rows of 32 and a border and padding of 5 on each side: 394 points.
const POPUP_12 = 12 * 32 + 10;

test("a 12-row menu in a 500 pt window is cut to the room beside its trigger and so keeps off it", () => {
  // The trigger is 28 tall at y 250: about 238 above and 206 below, as nsh's `place` counts (the gap is 4).
  const trigger = { top: 250, bottom: 278 };
  const room = roomAround(trigger, 4, 500);
  expect(room).toEqual({ above: 238, below: 210 });
  const rows = fitRows(POPUP_12, room);
  expect(rows).toBeDefined();
  const popup = (rows as number) + 10;
  // Whole on one side of the trigger: above it ends before the trigger starts (less the gap), nowhere under it.
  expect(popup).toBeLessThanOrEqual(Math.max(room.above, room.below));
  const above = popup <= room.above;
  const top = above ? trigger.top - 4 - popup : trigger.bottom + 4;
  expect(top >= 8 && top + popup <= 500 - 8).toBe(true);
  expect(top + popup <= trigger.top || top >= trigger.bottom).toBe(true);
});

test("a menu that fits on a side as it is is not cut, and a tiny window still leaves a row", () => {
  expect(fitRows(POPUP_12, roomAround({ top: 40, bottom: 68 }, 4, 800))).toBeUndefined();
  expect(fitRows(POPUP_12, roomAround({ top: 700, bottom: 728 }, 4, 800))).toBeUndefined();
  expect(fitRows(POPUP_12, { above: 20, below: 10 })).toBe(32);
});

test("a list opens on a row boundary, so its first row is whole, and keeps the chosen row in view", () => {
  const offsets = Array.from({ length: 13 }, (_, i) => i * 32);
  // centred on row 6 of a 160 pt viewport: 6 * 32 + 16 - 80 = 128, already a boundary
  expect(snapScroll(offsets, 128, 160)).toBe(128);
  // halfway through a row goes to the nearer boundary, never a sliver
  expect(snapScroll(offsets, 100, 160)).toBe(96);
  expect(snapScroll(offsets, 115, 160)).toBe(128);
  // at the end it stays flush with the list: the last row is whole
  expect(snapScroll(offsets, 300, 160)).toBe(224);
  expect(snapScroll(offsets, 0, 160)).toBe(0);
  // the chosen row is never pushed out of view by the snap: row 9 (288..320) needs the viewport to reach 320
  expect(snapScroll(offsets, 156, 160, 9)).toBe(160);
  expect(snapScroll(offsets, 300, 160, 2)).toBe(64);
});

test("headings and dividers of other heights snap to the rows' own tops", () => {
  // heading 28, item 32, divider 9, item 32
  const offsets = [0, 28, 60, 69, 101];
  expect(snapScroll(offsets, 30, 40)).toBe(28);
  expect(snapScroll(offsets, 66, 40)).toBe(60);
});

test("a menu is as wide as its longest row needs, between 208 and 320, so a label is cut only past the greatest", () => {
  const rows = (...labels: string[]) => menuRows(labels.map((label) => ({ label, onSelect: () => {} })));
  expect(menuWidth(rows("Open"))).toBe(208);
  const note = menuRows([{ label: "Add a note on this change", icon: "pencil", shortcut: "c", onSelect: () => {} }]);
  // The label (25 characters), the icon column, the keycap and the paddings: more than the least width.
  expect(menuWidth(note)).toBeGreaterThan(260);
  expect(menuWidth(rows("x".repeat(200)))).toBe(320);
});

test("a disabled row is plain muted, a danger one included; an enabled danger row is destructive", () => {
  const [off, on] = menuRows([
    { label: "Revert this change\u2026", icon: "undo", danger: true, disabled: true, onSelect: () => {} },
    { label: "Revert this file\u2026", icon: "trash", danger: true, onSelect: () => {} },
  ]) as ItemRow[];
  expect(rowTone(off)).toEqual({ text: "text-muted-foreground", icon: "muted-foreground" });
  expect(rowTone(on)).toEqual({ text: "text-destructive", icon: "destructive" });
});
