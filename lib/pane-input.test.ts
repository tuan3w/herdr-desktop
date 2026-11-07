import { expect, test } from "nsh/test";

import { matchRows } from "#lib/pane-input";

test("find: rows match ignoring case, diacritics and invisible characters, and an empty query matches nothing", () => {
  const rows = ["Building…", "Crème brûlée", "wor\u200bk done", "", "build again"];
  expect(matchRows(rows, "build")).toEqual([0, 4]);
  expect(matchRows(rows, "CREME")).toEqual([1]);
  expect(matchRows(rows, "work")).toEqual([2]);
  expect(matchRows(rows, "  ")).toEqual([]);
  expect(matchRows(rows, "zzz")).toEqual([]);
});
