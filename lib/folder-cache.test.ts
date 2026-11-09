import { expect, test } from "nsh/test";

import type { EntryView, FolderView } from "herdr-desktop/native";

import { folderCache, sameListing } from "#lib/folder-cache";

const entry = (name: string, over: Partial<EntryView> = {}): EntryView => ({
  name,
  kind: "file",
  size: 10,
  modified: 100,
  readable: true,
  link: false,
  ...over,
});

const folder = (path: string, entries: EntryView[] = []): FolderView => ({
  path,
  entries,
  truncated: false,
  skipped: 0,
});

test("a folder that was never listed is not there", () => {
  expect(folderCache.get("m-absent", "/nowhere")).toBeUndefined();
});

test("a listing is kept by machine and folder, and the same path on another machine is another folder", () => {
  const view = folder("/srv");
  folderCache.put("m-one", "/srv", view, 7);
  expect(folderCache.get("m-one", "/srv")).toEqual({ view, at: 7 });
  expect(folderCache.get("m-two", "/srv")).toBeUndefined();
});

test("the cache holds 64 folders: the oldest goes, and a folder put again is the newest", () => {
  const machine = "m-cap";
  for (let i = 0; i < 64; i++) folderCache.put(machine, `/d${i}`, folder(`/d${i}`), i);
  // /d0 is the oldest, but putting it again makes /d1 the oldest.
  folderCache.put(machine, "/d0", folder("/d0"), 99);
  folderCache.put(machine, "/d64", folder("/d64"), 64);
  expect(folderCache.get(machine, "/d1")).toBeUndefined();
  expect(folderCache.get(machine, "/d0")?.at).toBe(99);
  expect(folderCache.get(machine, "/d2")).toBeDefined();
  expect(folderCache.get(machine, "/d64")).toBeDefined();
});

test("two listings are the same when they draw the same table", () => {
  const a = folder("/srv", [entry("a.txt"), entry("b", { kind: "dir", size: 0 })]);
  const b = folder("/srv", [entry("a.txt"), entry("b", { kind: "dir", size: 0 })]);
  expect(sameListing(a, b)).toBe(true);
  // a missing time and an unknown one are the same row
  const unknown = folder("/srv", [entry("a", { modified: undefined })]);
  expect(sameListing(folder("/srv", [entry("a", { modified: null })]), unknown)).toBe(true);
});

test("a listing differs by a name, a size, a time, a kind, a count, a permission or its path", () => {
  const base = () => folder("/srv", [entry("a.txt"), entry("b.txt")]);
  expect(sameListing(base(), folder("/srv", [entry("a.txt")]))).toBe(false);
  expect(sameListing(base(), folder("/srv", [entry("a.txt"), entry("c.txt")]))).toBe(false);
  expect(sameListing(base(), folder("/srv", [entry("a.txt"), entry("b.txt", { size: 11 })]))).toBe(false);
  expect(sameListing(base(), folder("/srv", [entry("a.txt"), entry("b.txt", { modified: 101 })]))).toBe(false);
  expect(sameListing(base(), folder("/srv", [entry("a.txt"), entry("b.txt", { kind: "dir" })]))).toBe(false);
  expect(sameListing(base(), folder("/srv", [entry("a.txt"), entry("b.txt", { readable: false })]))).toBe(false);
  expect(sameListing(base(), folder("/other", [entry("a.txt"), entry("b.txt")]))).toBe(false);
  expect(sameListing(base(), { ...base(), truncated: true })).toBe(false);
});
