import { expect, test } from "nsh/test";

import type { EntryView } from "herdr-desktop/native";

import { arrange, crumbsOf, DEFAULT_SORT, firstSort, type FileSort, listingNote, sortOfPress } from "#lib/file-table";

const entry = (name: string, patch: Partial<EntryView> = {}): EntryView => ({
  name,
  kind: "file",
  size: 0,
  readable: true,
  link: false,
  ...patch,
});
const names = (rows: EntryView[]) => rows.map((e) => e.name);
const by = (key: FileSort["key"], direction: FileSort["direction"] = "ascending"): FileSort => ({ key, direction });

test("a path is a crumb per folder, from the root, whatever its slashes and characters", () => {
  const cases: [string, string[]][] = [
    ["/", ["/"]],
    ["", ["/"]],
    ["/home/dev/app", ["/", "home", "dev", "app"]],
    ["/home//dev/app/", ["/", "home", "dev", "app"]],
    ["/My Projects/ünï côde/日本語", ["/", "My Projects", "ünï côde", "日本語"]],
    ["~", ["~"]],
    ["~/work/app", ["~", "work", "app"]],
  ];
  for (const [path, expected] of cases) expect(crumbsOf(path).map((c) => c.name)).toEqual(expected);
  expect(crumbsOf("/home//dev/").map((c) => c.path)).toEqual(["/", "/home", "/home/dev"]);
  expect(crumbsOf("~/work").map((c) => c.path)).toEqual(["~", "~/work"]);
});

test("folders come first whatever the sort, and the sort orders each group", () => {
  const rows = [
    entry("b.txt", { size: 5, modified: 100 }),
    entry("a-dir", { kind: "dir" }),
    entry("c.txt", { size: 50, modified: 300 }),
    entry("z-dir", { kind: "dir" }),
    entry("a.txt", { size: 1, modified: 200 }),
  ];
  const opts = (sort: FileSort) => ({ sort, hidden: false });
  expect(names(arrange(rows, opts(by("name"))))).toEqual(["a-dir", "z-dir", "a.txt", "b.txt", "c.txt"]);
  expect(names(arrange(rows, opts(by("name", "descending"))))).toEqual(["z-dir", "a-dir", "c.txt", "b.txt", "a.txt"]);
  expect(names(arrange(rows, opts(by("size", "descending"))))).toEqual(["a-dir", "z-dir", "c.txt", "b.txt", "a.txt"]);
  expect(names(arrange(rows, opts(by("size"))))).toEqual(["a-dir", "z-dir", "a.txt", "b.txt", "c.txt"]);
  expect(names(arrange(rows, opts(by("modified", "descending"))))).toEqual([
    "a-dir",
    "z-dir",
    "c.txt",
    "a.txt",
    "b.txt",
  ]);
});

test("a name sorts by its letters not its case, digits as numbers, and duplicates in different case keep a fixed order", () => {
  const rows = [
    entry("file10"),
    entry("file2"),
    entry("Äpfel"),
    entry("apfel"),
    entry("README"),
    entry("readme"),
    entry("Readme"),
  ];
  const first = names(arrange(rows, { sort: DEFAULT_SORT, hidden: false }));
  expect(first.indexOf("file2")).toBeLessThan(first.indexOf("file10"));
  expect(first.slice(0, 2).sort()).toEqual(["apfel", "Äpfel"]);
  const again = names(arrange([...rows].reverse(), { sort: DEFAULT_SORT, hidden: false }));
  expect(again).toEqual(first);
  expect(new Set(first).size).toBe(rows.length);
});

test("dotfiles show only when asked, a missing date goes last either way, and no entries is no rows", () => {
  const rows = [entry(".env", { modified: 5 }), entry("a", { modified: null as never }), entry("b", { modified: 9 })];
  expect(names(arrange(rows, { sort: DEFAULT_SORT, hidden: false }))).toEqual(["a", "b"]);
  expect(names(arrange(rows, { sort: DEFAULT_SORT, hidden: true }))).toEqual([".env", "a", "b"]);
  expect(names(arrange(rows, { sort: by("modified"), hidden: false }))).toEqual(["b", "a"]);
  expect(names(arrange(rows, { sort: by("modified", "descending"), hidden: false }))).toEqual(["b", "a"]);
  expect(arrange([], { sort: DEFAULT_SORT, hidden: true })).toEqual([]);
});

test("a press on a title asks for that column, and the third press is the default order", () => {
  expect(sortOfPress({ key: "size", direction: "descending" })).toEqual(by("size", "descending"));
  expect(sortOfPress({ key: "modified", direction: "ascending" })).toEqual(by("modified"));
  expect(sortOfPress(null)).toEqual(DEFAULT_SORT);
  expect(sortOfPress({ key: "other", direction: "ascending" })).toEqual(DEFAULT_SORT);
});

test("choosing a column from the menu starts with what a person looks for", () => {
  expect(firstSort("name")).toEqual(by("name"));
  expect(firstSort("size")).toEqual(by("size", "descending"));
  expect(firstSort("modified")).toEqual(by("modified", "descending"));
});

test("the line under the list counts the items and says each limit in words", () => {
  expect(listingNote({ shown: 1, hidden: 0, truncated: false, skipped: 0 })).toBe("1 item");
  expect(listingNote({ shown: 0, hidden: 0, truncated: false, skipped: 0 })).toBe("0 items");
  expect(listingNote({ shown: 6, hidden: 1, truncated: true, skipped: 2 })).toBe(
    "6 items · 1 hidden · Only the first 5000 entries are listed · 2 names are not text and are not listed",
  );
});
