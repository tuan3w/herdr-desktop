import { expect, test } from "nsh/test";

import type { ChangeView } from "herdr-desktop/native";

import { bulkyText, groupDigits, isBulky, listItems, orderOf } from "#lib/changes";
import { scopeFiles } from "#lib/changes-scope";
import { groupFiles, NEW_FOLD_ABOVE, NEW_ROOT } from "#lib/changes-tree";

const change = (path: string, over: Partial<ChangeView> = {}): ChangeView => ({
  path,
  kind: "modified",
  staged: false,
  binary: false,
  submodule: false,
  fingerprint: `fp-${path}`,
  added: 2,
  removed: 1,
  ...over,
});

const ROOT = "/work/app";

test("a session's paths pick its files whether the agent wrote them absolute or relative to its folder", () => {
  const files = [
    change("src/a.ts"),
    change("src/b.ts"),
    change("pkg/c.ts"),
    change("out/x.json", { kind: "untracked" }),
  ];
  const pick = (paths: string[], bases = [ROOT]) => scopeFiles(files, paths, { root: ROOT, bases }).map((f) => f.path);
  expect(pick(["/work/app/src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  expect(pick(["./src/a.ts", "src//b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  // An agent working in a folder of the repository writes paths from there.
  expect(pick(["c.ts"], [ROOT, `${ROOT}/pkg`])).toEqual(["pkg/c.ts"]);
  // A folder that is a link to the root (macOS /var) still matches by its other spelling.
  expect(pick(["/private/work/app/src/a.ts"], [ROOT, "/private/work/app"])).toEqual(["src/a.ts"]);
});

test("a path git reports no change for is dropped, and a moved file counts through either name", () => {
  const files = [change("src/new-name.ts", { kind: "renamed", oldPath: "src/old-name.ts" }), change("src/a.ts")];
  const pick = (paths: string[]) => scopeFiles(files, paths, { root: ROOT, bases: [ROOT] }).map((f) => f.path);
  expect(pick(["src/committed.ts", "/elsewhere/src/a.ts"])).toEqual([]);
  expect(pick(["src/old-name.ts"])).toEqual(["src/new-name.ts"]);
  expect(pick(["src/new-name.ts", "src/a.ts"])).toEqual(["src/new-name.ts", "src/a.ts"]);
});

const output = (n: number, folder = "out") =>
  Array.from({ length: n }, (_, i) => change(`${folder}/f${i}.json`, { kind: "untracked", added: 1, removed: 0 }));

test("many files git does not know go to one closed section of folders; a handful stay ordinary changes", () => {
  const few = groupFiles([change("src/a.ts"), ...output(NEW_FOLD_ABOVE)]);
  expect(few.some((g) => g.quiet)).toBe(false);
  const files = [change("src/a.ts"), ...output(NEW_FOLD_ABOVE + 1, "out/a"), ...output(3, "logs")];
  const groups = groupFiles(files);
  expect(groups.map((g) => [g.key, g.quiet === true])).toEqual([
    ["dir:src", false],
    ["new:logs", true],
    ["new:out/a", true],
  ]);
  const items = listItems(files, "", undefined, new Set());
  // Closed: one line for the section with all of them counted, and the one change above it.
  expect(items.map((i) => (i.kind === "head" ? `${i.title}:${i.count}:${i.open}` : "file"))).toEqual([
    "src:1:true",
    "file",
    `Not in git:${NEW_FOLD_ABOVE + 4}:false`,
  ]);
  // Opened: the folders appear closed with their counts, never the files.
  const opened = listItems(files, "", undefined, new Set([NEW_ROOT]));
  expect(
    opened.filter((i) => i.kind === "head").map((i) => (i.kind === "head" ? `${i.title}:${i.count}:${i.open}` : "")),
  ).toEqual([
    "src:1:true",
    `Not in git:${NEW_FOLD_ABOVE + 4}:true`,
    "logs:3:false",
    `out/a:${NEW_FOLD_ABOVE + 1}:false`,
  ]);
  // A filter opens what matches, so a file is found without opening anything.
  expect(
    listItems(files, "f2", undefined, new Set()).some((i) => i.kind === "file" && i.change.path === "logs/f2.json"),
  ).toBe(true);
});

test("the files the session wrote are never put away with the output", () => {
  const mine = change("src/new.ts", { kind: "untracked" });
  const groups = groupFiles([mine, ...output(NEW_FOLD_ABOVE + 1)], { keep: new Set([mine.path]) });
  expect(groups[0]).toMatchObject({ key: "dir:src", quiet: false });
});

test("the biggest change goes first, folders and files alike, with conflicts still before everything", () => {
  const files = [
    change("a/small.ts", { added: 1, removed: 0 }),
    change("b/big.ts", { added: 90, removed: 10 }),
    change("b/mid.ts", { added: 20, removed: 0 }),
    change("a/clash.ts", { kind: "conflicted", added: 0, removed: 0 }),
    change("root.ts", { added: 5, removed: 5 }),
  ];
  expect(orderOf(files, { sort: "size" }).map((f) => f.path)).toEqual([
    "a/clash.ts",
    "b/big.ts",
    "b/mid.ts",
    "root.ts",
    "a/small.ts",
  ]);
  expect(orderOf(files).map((f) => f.path)).toEqual(["a/clash.ts", "root.ts", "a/small.ts", "b/big.ts", "b/mid.ts"]);
});

test("a new file that is output or huge is held back; code and every other kind of change is drawn", () => {
  const fresh = (path: string, over: Partial<ChangeView> = {}) => change(path, { kind: "untracked", ...over });
  expect(isBulky(fresh("data/events.json", { size: 2_000_000, added: 40_000 }))).toBe(true);
  expect(isBulky(fresh("run.log", { size: 40 * 1024, added: 300 }))).toBe(true);
  expect(isBulky(fresh("src/big.ts", { size: 300 * 1024, added: 3000 }))).toBe(true);
  expect(isBulky(fresh("src/gen.ts", { size: 20 * 1024, added: 4001 }))).toBe(true);
  expect(isBulky(fresh("src/app.ts", { size: 6000, added: 200 }))).toBe(false);
  expect(isBulky(fresh("small.json", { size: 2000, added: 20 }))).toBe(false);
  expect(isBulky(fresh("model.bin", { size: 9_000_000, binary: true }))).toBe(false);
  expect(isBulky(change("data/events.json", { size: 2_000_000, added: 40_000 }))).toBe(false);
  expect(groupDigits(40000)).toBe("40,000");
  expect(groupDigits(999)).toBe("999");
  expect(bulkyText({ size: 2048, added: 12000 })).toMatch(/^New file · .+ · 12,000 lines$/);
});
