import { expect, test } from "nsh/test";

import { boardData, machine, project, row } from "#lib/board-rows.fixture";
import type { SidebarItem } from "#lib/sidebar";
import {
  ageText,
  matches,
  monogram,
  MONOGRAM_TONES,
  projectFolder,
  projectLabel,
  projectSummary,
  QUIET_SHOWN,
  rowLabel,
  shownRows,
  sidebarItems,
} from "#lib/sidebar";

const shape = (items: SidebarItem[]) =>
  items.map((i) => {
    switch (i.kind) {
      case "host":
        return `@ ${i.status.name}`;
      case "project":
        return `# ${i.project.name}${i.folded ? " (folded)" : ""}`;
      case "checkout":
        return `~ ${i.checkout.name}`;
      case "row":
        return i.row.name;
      case "more":
        return `more ${i.count} ${i.open}`;
    }
  });
const one = [machine("local")];

test("projects list in the board's order with their agents under them, and a single healthy machine has no header", () => {
  const board = boardData([
    project("api", [
      row("local/p1", { name: "blocked one", status: "blocked" }),
      row("local/p2", { name: "busy one" }),
    ]),
    project("web", [row("local/p3", { name: "quiet one", status: "idle" })]),
  ]);
  expect(shape(sidebarItems(board, one, "", [], []))).toEqual([
    "# api",
    "blocked one",
    "busy one",
    "# web",
    "quiet one",
  ]);
});

test("with several machines each is a header over its own projects, and a machine with a problem is listed even alone", () => {
  const board = boardData([
    project("api", [row("local/p1", { name: "mine" })]),
    project("api", [row("lab/p2", { name: "theirs" })]),
  ]);
  expect(shape(sidebarItems(board, [machine("local"), machine("lab")], "", [], []))).toEqual([
    "@ This computer",
    "# api",
    "mine",
    "@ lab",
    "# api",
    "theirs",
  ]);
  expect(shape(sidebarItems(boardData([]), [machine("local", { state: "offline" })], "", [], []))).toEqual([
    "@ This computer",
  ]);
});

test("a folded project keeps its header and hides its agents", () => {
  const api = project("api", [row("local/p1"), row("local/p2")]);
  expect(shape(sidebarItems(boardData([api]), one, "", [api.key], []))).toEqual(["# api (folded)"]);
});

test("a project with several checkouts groups its agents under them, the main one first", () => {
  const rows = [
    row("local/p1", { name: "on hotfix", checkout: "/w/hotfix" }),
    row("local/p2", { name: "on main", checkout: "/w/api" }),
  ];
  const api = project("api", rows, {
    checkouts: [
      { path: "/w/api", name: "api", linked: false },
      { path: "/w/hotfix", name: "hotfix", linked: true },
    ],
  });
  expect(shape(sidebarItems(boardData([api]), one, "", [], []))).toEqual([
    "# api",
    "~ api",
    "on main",
    "~ hotfix",
    "on hotfix",
  ]);
  const single = project("web", [row("local/p3", { name: "alone", checkout: "/w/web" })], {
    checkouts: [{ path: "/w/web", name: "web", linked: false }],
  });
  expect(shape(sidebarItems(boardData([single]), one, "", [], []))).toEqual(["# web", "alone"]);
});

test("idle agents beyond the first few sit behind one line per project that opens and closes them", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => row(`local/i${n}`, { name: `idle ${n}`, status: "idle" }));
  const quiet = project("q", rows);
  expect(shape(sidebarItems(boardData([quiet]), one, "", [], [])).slice(-2)).toEqual(["idle 3", "more 2 false"]);
  expect(shape(sidebarItems(boardData([quiet]), one, "", [], [quiet.key])).slice(-3)).toEqual([
    "idle 4",
    "idle 5",
    "more 2 true",
  ]);
  const { shown, hidden } = shownRows(rows, false);
  expect([shown.length, hidden]).toEqual([QUIET_SHOWN, 2]);
});

test("whoever works or waits is always listed, however many idle agents the project has", () => {
  const rows = [
    row("local/w1", { name: "busy", status: "working" }),
    ...[1, 2, 3, 4].map((n) => row(`local/i${n}`, { status: "idle" })),
    row("local/b1", { name: "asks", status: "blocked" }),
  ];
  const names = shownRows(rows, false).shown.map((r) => r.name);
  expect(names).toContain("busy");
  expect(names).toContain("asks");
});

test("a search finds agents and projects, also the folded and the hidden idle ones, and ignores case and accents", () => {
  const board = boardData([
    project("api", [row("local/p1", { name: "Crème pipeline", status: "blocked" }), row("local/p2", { name: "docs" })]),
    project(
      "notes",
      [1, 2, 3, 4, 5].map((n) => row(`local/i${n}`, { name: n === 5 ? "old creme job" : "other", status: "idle" })),
    ),
  ]);
  const hits = shape(sidebarItems(board, one, "CREME", [board.projects[0].key], []));
  expect(hits).toEqual(["# api", "Crème pipeline", "# notes", "old creme job"]);
  expect(shape(sidebarItems(board, one, "notes", [], []))).toEqual([
    "# notes",
    "other",
    "other",
    "other",
    "other",
    "old creme job",
  ]);
  expect(sidebarItems(board, one, "nothing like it", [], [])).toEqual([]);
});

test("a search narrows by every word, over project, name, agent, machine and folder", () => {
  const r = row("m1/p1", { name: "api fix", agent: "codex", cwd: "/home/dev/payments" });
  expect(matches(r, "ledger", "codex payments")).toBe(true);
  expect(matches(r, "ledger", "codex billing")).toBe(false);
  expect(matches(r, "ledger", "m1 api ledger")).toBe(true);
  expect(matches(r, "ledger", "   ")).toBe(true);
});

test("a screen reader hears name, agent, state, project, machine and how long, and that the state may be old", () => {
  const r = row("local/p1", { name: "api fix", status: "blocked", sinceSecs: 130 });
  expect(rowLabel(r, "payments")).toBe("api fix, claude, needs you, payments, This computer, 2 min");
  expect(rowLabel(row("local/p1", { name: "api fix", agent: "", offline: true, status: "idle" }), "payments")).toBe(
    "api fix, idle, payments, This computer, offline",
  );
});

test("a project is read as its name, machine and what it needs, saying only what is not zero", () => {
  const busy = project("payments", [
    row("local/a", { status: "blocked" }),
    row("local/b", { status: "blocked" }),
    row("local/c"),
    row("local/d", { status: "done" }),
  ]);
  expect(projectLabel({ ...busy, pinned: true })).toBe(
    "payments, This computer, 2 need you, 1 working, 1 to review, pinned",
  );
  expect(projectLabel(project("quiet", [row("local/a", { status: "idle" })]))).toBe("quiet, This computer");
});

test("a new session in a project starts in its main checkout, else the first checkout, else where its agents work", () => {
  const checkouts = [
    { path: "/w/hotfix", name: "hotfix", linked: true },
    { path: "/w/api", name: "api", linked: false },
  ];
  expect(projectFolder({ checkouts, rows: [] })).toBe("/w/api");
  expect(projectFolder({ checkouts: [checkouts[0]], rows: [] })).toBe("/w/hotfix");
  expect(projectFolder({ checkouts: [], rows: [row("local/a", { cwd: "/home/dev/notes" })] })).toBe("/home/dev/notes");
  expect(projectFolder({ checkouts: [], rows: [row("local/a")] })).toBe("");
});

test("a project's monogram is its first letters and keeps its tint whatever else changes", () => {
  expect(monogram("payments-api").letters).toBe("PA");
  expect(monogram("web").letters).toBe("W");
  expect(monogram("Écoute").letters).toBe("É");
  expect(monogram("payments-api")).toEqual(monogram("Payments-API"));
  const tones = new Set(
    ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map((n) => monogram(n).tone),
  );
  expect(tones.size).toBeGreaterThan(1);
  for (const tone of tones) expect(tone).toBeLessThan(MONOGRAM_TONES);
});

test("ages read as a glance wants them", () => {
  expect([null, 10, 90, 3500, 7300, 200000].map(ageText)).toEqual(["", "just now", "2 min", "58 min", "2 h", "2 d"]);
});

test("a project says what it does once: the number alone in the sidebar, every part in words on a card", () => {
  const mixed = { needsYou: 2, working: 1, toReview: 3 };
  expect(projectSummary(mixed, true)).toBe("2");
  expect(projectSummary(mixed, false)).toBe("2 waiting · 1 working · 3 to review");
  expect(projectSummary({ needsYou: 0, working: 2, toReview: 1 }, true)).toBe("2 working");
  expect(projectSummary({ needsYou: 0, working: 0, toReview: 1 }, true)).toBe("1 to review");
  expect(projectSummary({ needsYou: 0, working: 0, toReview: 0 }, false)).toBe("");
});
