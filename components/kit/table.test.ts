import { expect, test } from "nsh/test";
import { type Column, fittingColumns, sortedRows } from "./table";

interface Row {
  name: string;
  started: string;
  open: number;
}

const ROWS: Row[] = [
  { name: "Ångström", started: "2026-11-03", open: 8 },
  { name: "Hélène", started: "", open: 3 },
  { name: "Mia", started: "2026-10-18", open: 5 },
  { name: "Édouard", started: "2026-10-30", open: 12 },
];

const COLUMNS: Column<Row>[] = [
  { key: "name", title: "Agent", width: 100, text: (r) => r.name },
  { key: "started", title: "Started", width: 80, text: (r) => r.started, sortBy: (r) => r.started },
  { key: "open", title: "Tasks", width: 60, text: (r) => String(r.open), sortBy: (r) => r.open },
];

const names = (rows: Row[]) => rows.map((r) => r.name);

test("no sort keeps the order the caller gave", () => {
  expect(names(sortedRows(ROWS, COLUMNS, null))).toEqual(names(ROWS));
  expect(names(sortedRows(ROWS, COLUMNS, { key: "started" }))).toEqual(names(ROWS));
});

test("numbers sort as numbers, not as text", () => {
  expect(sortedRows(ROWS, COLUMNS, { key: "open", direction: "ascending" }).map((r) => r.open)).toEqual([3, 5, 8, 12]);
  expect(sortedRows(ROWS, COLUMNS, { key: "open", direction: "descending" }).map((r) => r.open)).toEqual([12, 8, 5, 3]);
});

test("a missing value goes last whichever way the column runs", () => {
  expect(sortedRows(ROWS, COLUMNS, { key: "started", direction: "ascending" }).map((r) => r.started)).toEqual(["2026-10-18", "2026-10-30", "2026-11-03", ""]);
  expect(sortedRows(ROWS, COLUMNS, { key: "started", direction: "descending" }).map((r) => r.started)).toEqual(["2026-11-03", "2026-10-30", "2026-10-18", ""]);
});

test("text sorts without regard to accents, and does not change the caller's array", () => {
  const before = names(ROWS);
  expect(names(sortedRows(ROWS, COLUMNS, { key: "name", direction: "ascending" }))).toEqual(["Ångström", "Édouard", "Hélène", "Mia"]);
  expect(names(ROWS)).toEqual(before);
});

test("a sort asks for each row's key once, however many rows it compares", () => {
  let calls = 0;
  const counted: Column<Row>[] = [{ key: "open", title: "Tasks", width: 60, text: (r) => String(r.open), sortBy: (r) => (calls++, r.open) }];
  const many = Array.from({ length: 500 }, (_, i) => ({ name: `n${i}`, started: "", open: (i * 37) % 101 }));
  sortedRows(many, counted, { key: "open", direction: "ascending" });
  expect(calls).toBe(500);
});

const WIDE: Column<Row>[] = [
  { key: "name", title: "Agent", width: 100, text: (r) => r.name },
  { key: "started", title: "Started", width: 80, drop: 2, text: (r) => r.started },
  { key: "open", title: "Tasks", width: 60, drop: 1, text: (r) => String(r.open) },
];
const keys = (columns: Column<Row>[]) => columns.map((c) => c.key);

test("a narrow table drops its optional columns lowest first, only as many as needed", () => {
  expect(keys(fittingColumns(WIDE, 240))).toEqual(["name", "started", "open"]);
  expect(keys(fittingColumns(WIDE, 200))).toEqual(["name", "started"]);
  expect(keys(fittingColumns(WIDE, 150))).toEqual(["name"]);
});

test("a column without a drop order never leaves, and an unmeasured table shows everything", () => {
  expect(keys(fittingColumns(WIDE, 40))).toEqual(["name"]);
  expect(keys(fittingColumns(WIDE, 0))).toEqual(["name", "started", "open"]);
});
