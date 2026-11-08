import { expect, test } from "nsh/test";

import type { ChangeView, DiffView } from "herdr-desktop/native";

import { project, row } from "#lib/board-rows.fixture";
import {
  agentsIn,
  checkoutNameOf,
  branchText,
  checkoutsOf,
  fileLabel,
  isReviewed,
  listItems,
  MARKS_CAP,
  matches,
  type Note,
  noteOn,
  notesMessage,
  pruned,
  readMarks,
  splitPath,
  statsText,
  stepFile,
  totalsOf,
  filesText,
  identityFit,
  agentPart,
  KIND_MARK,
  withCheckout,
  withMark,
} from "#lib/changes";
import { dirKey, dirOf, groupFiles, nameOf } from "#lib/changes-tree";

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

const FILES: ChangeView[] = [
  change("src/b.ts"),
  change("src/a.ts", { added: 12, removed: 3 }),
  change("docs/new.md", { kind: "untracked", added: 7, removed: 0 }),
  change("gone.ts", { kind: "deleted", added: 0, removed: 9 }),
  change("src/clash.ts", { kind: "conflicted" }),
];

test("the list groups files by folder, conflicts first, the root next, each group by name", () => {
  const items = listItems(FILES, "", undefined, new Set());
  const shape = items.map((i) => (i.kind === "head" ? `# ${i.title} ${i.count}` : i.change.path));
  expect(shape).toEqual([
    "# Merge conflicts 1",
    "src/clash.ts",
    "# Top level 1",
    "gone.ts",
    "# docs 1",
    "docs/new.md",
    "# src 2",
    "src/a.ts",
    "src/b.ts",
  ]);
});

test("a folded group shows its heading and count only, and a filter drops the groups it empties", () => {
  const folded = listItems(FILES, "", undefined, new Set([dirKey("src")]));
  expect(folded.filter((i) => i.kind === "file").map((i) => i.kind === "file" && i.change.path)).not.toContain(
    "src/a.ts",
  );
  expect(folded.some((i) => i.kind === "head" && i.group === "dir:src" && i.count === 2 && !i.open)).toBe(true);
  const narrowed = listItems(FILES, "NEW", undefined, new Set());
  expect(narrowed.map((i) => (i.kind === "head" ? i.title : i.change.path))).toEqual(["docs", "docs/new.md"]);
});

test("a filter takes every word, any case, accents ignored, in the path or where it came from", () => {
  expect(matches(change("src/Café/menu.ts"), "cafe MENU")).toBe(true);
  expect(matches(change("src/a.ts"), "src zzz")).toBe(false);
  expect(matches(change("new.ts", { oldPath: "old/place.ts" }), "place")).toBe(true);
  expect(matches(change("a.ts"), "   ")).toBe(true);
});

test("a row says where it is, what happened and how much, as words a reader can follow", () => {
  expect(fileLabel(change("src/a.ts", { added: 12, removed: 3 }), false)).toBe("src/a.ts, modified, +12 \u22123");
  expect(fileLabel(change("src/a.ts"), true)).toBe("src/a.ts, modified, +2 \u22121, reviewed");
  expect(fileLabel(change("n.ts", { kind: "renamed", oldPath: "o.ts" }), false)).toBe(
    "n.ts, renamed, from o.ts, +2 \u22121",
  );
  expect(fileLabel(change("d.ts", { kind: "untracked" }), false)).toContain("new, not in git");
  expect(statsText(change("b.png", { binary: true, added: null, removed: null, size: 2048 }))).toBe("binary, 2 KB");
  expect(statsText(change("sub", { submodule: true }))).toBe("repository");
  expect(statsText(change("huge.log", { added: null, removed: null, size: 100 * 1024 * 1024 }))).toBe("100 MB");
});

test("paths split into folder and name", () => {
  expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib/", name: "a.ts" });
  expect(splitPath("a.ts")).toEqual({ dir: "", name: "a.ts" });
});

test("a reviewed mark holds for the change that was reviewed and no other", () => {
  const a = change("src/a.ts");
  const marked = withMark(undefined, a, true);
  expect(isReviewed(marked, a)).toBe(true);
  expect(isReviewed(marked, { ...a, fingerprint: "edited since" })).toBe(false);
  expect(isReviewed(marked, change("src/b.ts"))).toBe(false);
  expect(isReviewed(withMark(marked, a, false), a)).toBe(false);
  expect(isReviewed(undefined, a)).toBe(false);
});

test("marks of files that are no longer changed are dropped, and untouched marks are the same object", () => {
  const marks = { "src/a.ts": "x", "gone/for/good.ts": "y" };
  expect(pruned(marks, FILES)).toEqual({ "src/a.ts": "x" });
  const kept = { "src/a.ts": "x" };
  expect(pruned(kept, FILES)).toBe(kept);
  expect(pruned(undefined, FILES)).toBeUndefined();
});

test("saved marks are read defensively and kept for a bounded number of checkouts, the newest last", () => {
  expect(readMarks(null)).toEqual({});
  expect(readMarks("nope")).toEqual({});
  expect(readMarks({ a: { "x.ts": "f", "y.ts": 3 }, b: 4, c: {} })).toEqual({ a: { "x.ts": "f" } });
  let all: Record<string, Record<string, string>> = {};
  for (let i = 0; i < MARKS_CAP + 5; i++) all = withCheckout(all, `m\n/repo${i}`, { "a.ts": "f" });
  expect(Object.keys(all).length).toBe(MARKS_CAP);
  expect(all["m\n/repo0"]).toBeUndefined();
  expect(all[`m\n/repo${MARKS_CAP + 4}`]).toBeDefined();
  expect(withCheckout(all, `m\n/repo${MARKS_CAP + 4}`, {})[`m\n/repo${MARKS_CAP + 4}`]).toBeUndefined();
});

test("j and k stop at the ends of the list and start from the nearest end when nothing is selected", () => {
  const order = [change("a"), change("b"), change("c")];
  expect(stepFile(order, null, 1)).toBe("a");
  expect(stepFile(order, null, -1)).toBe("c");
  expect(stepFile(order, "b", 1)).toBe("c");
  expect(stepFile(order, "c", 1)).toBe("c");
  expect(stepFile(order, "a", -1)).toBe("a");
  expect(stepFile(order, "gone", 1)).toBe("a");
  expect(stepFile([], "a", 1)).toBeNull();
});

test("the header counts files and lines and says nothing it does not know", () => {
  expect(totalsOf(FILES)).toEqual({ files: 5, added: 23, removed: 14 });
  expect(totalsOf([change("a", { added: null, removed: null, binary: true })])).toEqual({
    files: 1,
    added: 0,
    removed: 0,
  });
  expect(filesText(1)).toBe("1 file");
  expect(filesText(0)).toBe("0 files");
});

test("the header drops the agent, then the machine, whole, and never the project or the branch", () => {
  const w = { project: 80, branch: 60, machine: 70, agent: 90 };
  expect(identityFit({ ...w, room: 400 })).toEqual({ machine: true, agent: true });
  expect(identityFit({ ...w, room: 290 })).toEqual({ machine: true, agent: false });
  expect(identityFit({ ...w, room: 200 })).toEqual({ machine: false, agent: false });
  expect(identityFit({ ...w, room: 100 })).toEqual({ machine: false, agent: false });
  // This computer has no machine part: the agent has the room alone.
  expect(identityFit({ ...w, machine: 0, room: 240 })).toEqual({ machine: false, agent: true });
  // Nothing known, nothing drawn.
  expect(identityFit({ ...w, machine: 0, agent: 0, room: 999 })).toEqual({ machine: false, agent: false });
});

test("the header names the one agent, else counts them, and says nothing when none works there", () => {
  expect(agentPart([])).toEqual({ text: "", tip: "" });
  expect(agentPart([{ name: "claude-1", agent: "claude" }])).toEqual({ text: "claude-1", tip: "claude-1" });
  expect(
    agentPart([
      { name: "", agent: "omp" },
      { name: "b", agent: "claude" },
    ]),
  ).toEqual({ text: "2 agents", tip: "omp, b" });
});

test("every kind of change has its own one-letter mark", () => {
  expect(new Set(Object.values(KIND_MARK)).size).toBe(Object.keys(KIND_MARK).length);
  expect(KIND_MARK.modified).toBe("M");
  expect(KIND_MARK.conflicted).toBe("!");
});

test("the branch line says where HEAD is, how far from its upstream, and a linked worktree", () => {
  const base = { branch: "main", detached: false, head: "abc1234", ahead: 0, behind: 0, linked: false, unborn: false };
  expect(branchText(base)).toBe("main");
  expect(branchText({ ...base, ahead: 2, behind: 1 })).toBe("main \u00b7 2 ahead \u00b7 1 behind");
  expect(branchText({ ...base, linked: true })).toBe("main \u00b7 worktree");
  expect(branchText({ ...base, branch: null, detached: true })).toBe("detached at abc1234");
  expect(branchText({ ...base, unborn: true, head: null })).toBe("main");
});

const diff: Pick<DiffView, "path"> = { path: "src/auth.ts" };

test("a note points at the lines it is about and quotes them", () => {
  const group = { index: 1, added: 2, removed: 1, line: 12, endLine: 13, lines: ["-old", "+new", "+newer"], more: 0 };
  const note = noteOn(diff, group, "  use a constant  ", 7, "fp");
  expect(note).toMatchObject({ id: 7, path: "src/auth.ts", group: 1, line: 12, endLine: 13, text: "use a constant" });
  expect(note.removedOnly).toBe(false);
  expect(noteOn(diff, { ...group, added: 0, lines: ["-old"] }, "why", 8, "fp").removedOnly).toBe(true);
});

test("the notes are one message: what it is, then each note as place, quoted code and the words", () => {
  const notes: Note[] = [
    {
      id: 1,
      path: "src/auth.ts",
      group: 0,
      line: 12,
      endLine: 14,
      quote: ["-const a = 1;", "+const a = 2;"],
      more: 0,
      removedOnly: false,
      text: "Use a named constant.",
      fingerprint: "f",
    },
    {
      id: 2,
      path: "src/session.ts",
      group: 2,
      line: 30,
      endLine: 30,
      quote: ["-gone"],
      more: 3,
      removedOnly: true,
      text: "Was this needed?",
      fingerprint: "f",
    },
  ];
  expect(notesMessage(notes, "accounts")).toBe(
    [
      "Notes on your changes in accounts (2):",
      "",
      "src/auth.ts:12-14",
      "> -const a = 1;",
      "> +const a = 2;",
      "Use a named constant.",
      "",
      "src/session.ts:30 (lines removed here)",
      "> -gone",
      "> \u2026 3 more changed lines",
      "Was this needed?",
    ].join("\n"),
  );
  const long = { ...notes[0], quote: [`+${"x".repeat(400)}`] };
  expect(notesMessage([long]).split("\n")[3].length).toBeLessThan(210);
  expect(notesMessage([long]).startsWith("Notes on your changes (1):")).toBe(true);
});

const same = (_machine: string, path: string) => path;

test("the agents of a checkout are the online ones working in it or under it", () => {
  const rows = [
    row("m1/p1", { name: "here", cwd: "/work/app" }),
    row("m1/p2", { name: "deeper", cwd: "/work/app/packages/ui" }),
    row("m1/p3", { name: "sibling", cwd: "/work/app-2" }),
    row("m2/p4", { name: "other machine", cwd: "/work/app" }),
    row("m1/p5", { name: "away", cwd: "/work/app", offline: true }),
    row("m1/p6", { name: "by checkout", checkout: "/work/app" }),
  ];
  expect(agentsIn(rows, "m1", "/work/app", same).map((r) => r.name)).toEqual(["here", "deeper", "by checkout"]);
});

test("an agent in a link to the checkout is in the checkout, trailing slash or not", () => {
  // git reports `/private/var/x`; the agent's shell says `/var/x`. Only the machine's own file system knows they match.
  const real = (_machine: string, path: string) => path.replace(/^\/var\//, "/private/var/");
  const rows = [
    row("m1/p1", { name: "linked", cwd: "/var/x" }),
    row("m1/p2", { name: "linked below", cwd: "/var/x/src/" }),
    row("m1/p3", { name: "linked sibling", cwd: "/var/x-2" }),
    row("m1/p4", { name: "linked checkout", checkout: "/var/x" }),
  ];
  expect(agentsIn(rows, "m1", "/private/var/x/", real).map((r) => r.name)).toEqual([
    "linked",
    "linked below",
    "linked checkout",
  ]);
  expect(agentsIn(rows, "m1", "/private/var/x", same)).toEqual([]);
});

test("a project's checkouts are its worktrees, else the folders its agents work in", () => {
  const withCheckouts = project("app", [], {
    checkouts: [
      { path: "/w/app", name: "app", linked: false },
      { path: "/w/app-fix", name: "app-fix", linked: true },
    ],
  });
  expect(checkoutsOf(withCheckouts).map((c) => c.path)).toEqual(["/w/app", "/w/app-fix"]);
  const folders = project("scripts", [
    row("local/p1", { cwd: "/x/one" }),
    row("local/p2", { cwd: "/x/one" }),
    row("local/p3", { cwd: "/x/two" }),
  ]);
  expect(checkoutsOf(folders)).toEqual([
    { path: "/x/one", name: "one" },
    { path: "/x/two", name: "two" },
  ]);
});

test("a checkout behind a link is named by its project and worktree", () => {
  const real = (_machine: string, path: string) => path.replace(/^\/var\//, "/private/var/");
  const projects = [
    project("app", [], {
      machine: "local",
      checkouts: [
        { path: "/private/var/x", name: "app", linked: false },
        { path: "/private/var/x-fix", name: "x-fix", linked: true },
      ],
    }),
  ];
  expect(checkoutNameOf(projects, "local", "/var/x-fix/", real)).toBe("app \u00b7 x-fix");
  expect(checkoutNameOf(projects, "local", "/var/x", real)).toBe("app");
  expect(checkoutNameOf(projects, "local", "/elsewhere/tool", real)).toBe("tool");
});

const shapeOf = (paths: string[], over: Partial<ChangeView> = {}) =>
  groupFiles(paths.map((p) => change(p, over))).map((g) => [g.title, g.files.map((f) => nameOf(f.path))]);

test("two files of one name in two folders sit under their own folder, so the folder tells them apart", () => {
  expect(shapeOf(["native/core/src/board.rs", "native/app/src/engine.rs", "native/app/tests/engine.rs"])).toEqual([
    ["native/app/src", ["engine.rs"]],
    ["native/app/tests", ["engine.rs"]],
    ["native/core/src", ["board.rs"]],
  ]);
});

test("a chain of folders with no file of its own costs no heading; the deep folder is named whole once", () => {
  expect(
    shapeOf([".agents/skills/herdr-design/SKILL.md", ".agents/skills/herdr-design/refs/a.md", "native/app/src/x.rs"]),
  ).toEqual([
    [".agents/skills/herdr-design", ["SKILL.md"]],
    [".agents/skills/herdr-design/refs", ["a.md"]],
    ["native/app/src", ["x.rs"]],
  ]);
});

test("a folder reads before its subfolders, and a root file before every folder", () => {
  expect(shapeOf(["a/b/z.ts", "a/y.ts", "a-b/x.ts", "r.ts", "A/w.ts"]).map((g) => g[0])).toEqual([
    "Top level",
    "A",
    "a",
    "a/b",
    "a-b",
  ]);
});

test("long names, spaces and unicode stay whole and in order; no file gives no group", () => {
  const long = `${"very-long-component-name-".repeat(5)}test.tsx`;
  expect(shapeOf([`docs/My Notes/${long}`, "docs/My Notes/caf\u00e9 \u65e5\u672c.md", "docs/My Notes/b.md"])).toEqual([
    ["docs/My Notes", ["b.md", "caf\u00e9 \u65e5\u672c.md", long]],
  ]);
  expect(groupFiles([])).toEqual([]);
  expect(listItems([], "", undefined, new Set())).toEqual([]);
});

test("a trailing slash (a nested repository) names the folder as its parent and the repository as the file", () => {
  expect(dirOf("vendor/repo/")).toBe("vendor");
  expect(nameOf("vendor/repo/")).toBe("repo");
  expect(dirOf("a.ts")).toBe("");
});
