import { expect, test } from "nsh/test";

import { boardData, machine, project, row } from "#lib/board-rows.fixture";
import type { SidebarItem } from "#lib/sidebar";
import {
  ageText,
  arrange,
  folderTails,
  footerMachines,
  keepItems,
  matches,
  monogram,
  MONOGRAM_TONES,
  moveProject,
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
      case "section":
        return `== ${i.label}${i.state ? ` (${i.state})` : ""}${i.folded ? ` (folded ${i.needsYou})` : ""}`;
      case "project":
        return `# ${i.project.name}${i.machine ? ` on ${i.machine}` : ""}${i.tail ? ` ${i.tail}` : ""}${i.folded ? " (folded)" : ""}`;
      case "quiet":
        return `${i.count} quiet ${i.open ? "open" : "shut"}`;
      case "checkout":
        return `~ ${i.checkout.name}`;
      case "row":
        return i.row.name;
      case "more":
        return `more ${i.count} ${i.open}`;
    }
  });
const one = [machine("local")];
const two = [machine("local"), machine("lab")];

test("a section of this computer lists its projects with their agents under them, its quiet ones behind one line", () => {
  const board = boardData([
    project("api", [
      row("local/p1", { name: "blocked one", status: "blocked" }),
      row("local/p2", { name: "busy one" }),
    ]),
    project("web", [row("local/p3", { name: "quiet one", status: "idle" })]),
  ]);
  expect(shape(sidebarItems(board, one))).toEqual([
    "== This computer",
    "# api",
    "blocked one",
    "busy one",
    "1 quiet shut",
  ]);
});

test("sections are Pinned, then this computer, then the other machines by name, and a pinned project is listed once", () => {
  const board = boardData([
    project("api", [row("zeta/p1", { name: "on zeta" })], { pinned: true }),
    project("docs", [row("local/p2", { name: "pinned here" })], { pinned: true }),
    project("api", [row("alpha/p3", { name: "on alpha" })]),
    project("web", [row("local/p4", { name: "mine" })]),
    project("tools", [row("zeta/p5", { name: "zeta tools" })]),
  ]);
  const items = sidebarItems(board, [machine("local"), machine("zeta"), machine("alpha")]);
  expect(shape(items)).toEqual([
    "== Pinned",
    "# api on zeta",
    "on zeta",
    "# docs",
    "pinned here",
    "== This computer",
    "# web",
    "mine",
    "== alpha",
    "# api",
    "on alpha",
    "== zeta",
    "# tools",
    "zeta tools",
  ]);
  expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  // Nothing pinned: no Pinned label at all.
  expect(shape(sidebarItems(boardData([project("web", [row("local/p1", { name: "mine" })])]), one))[0]).toBe(
    "== This computer",
  );
});

test("a machine's section says its link in a word only while it is not live, and its projects stay listed and stale", () => {
  const board = boardData([project("api", [row("local/p1")]), project("api", [row("lab/p2", { offline: true })])]);
  const read = (state: "online" | "offline" | "connecting") =>
    sidebarItems(board, [machine("local"), machine("lab", { state })]);
  expect(shape(read("online"))).toEqual(["== This computer", "# api", "agent p1", "== lab", "# api", "agent p2"]);
  expect(shape(read("offline"))).toContain("== lab (offline)");
  expect(shape(read("connecting"))).toContain("== lab (stale)");
  expect(read("offline").flatMap((i) => (i.kind === "project" ? [i.stale] : []))).toEqual([false, true]);
  expect(sidebarItems(boardData([]), [machine("local", { state: "offline" })])).toEqual([]);
});

test("a folded project keeps its header and hides its agents", () => {
  const api = project("api", [row("local/p1"), row("local/p2")]);
  expect(shape(sidebarItems(boardData([api]), one, { folds: [api.key] }))).toEqual([
    "== This computer",
    "# api (folded)",
  ]);
});

test("a folded section hides its projects and says how many of its agents wait", () => {
  const board = boardData([
    project("api", [row("lab/p1", { status: "blocked" }), row("lab/p2", { status: "blocked" })]),
    project("web", [row("local/p3")]),
  ]);
  expect(shape(sidebarItems(board, two, { sections: ["machine:lab", "machine:local"] }))).toEqual([
    "== This computer (folded 0)",
    "== lab (folded 2)",
  ]);
  // A search looks through folded sections.
  expect(shape(sidebarItems(board, two, { sections: ["machine:lab"], query: "p1" }))).toEqual([
    "== lab",
    "# api",
    "agent p1",
  ]);
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
  expect(shape(sidebarItems(boardData([api]), one)).slice(1)).toEqual([
    "# api",
    "~ api",
    "on main",
    "~ hotfix",
    "on hotfix",
  ]);
  const single = project("web", [row("local/p3", { name: "alone", checkout: "/w/web" })], {
    checkouts: [{ path: "/w/web", name: "web", linked: false }],
  });
  expect(shape(sidebarItems(boardData([single]), one)).slice(1)).toEqual(["# web", "alone"]);
});

test("idle agents beyond the first few sit behind one line per project that opens and closes them", () => {
  const rows = [
    row("local/w0", { name: "busy" }),
    ...[1, 2, 3, 4, 5].map((n) => row(`local/i${n}`, { name: `idle ${n}`, status: "idle" })),
  ];
  const q = project("q", rows);
  expect(shape(sidebarItems(boardData([q]), one)).slice(-2)).toEqual(["idle 3", "more 2 false"]);
  expect(shape(sidebarItems(boardData([q]), one, { opened: [q.key] })).slice(-3)).toEqual([
    "idle 4",
    "idle 5",
    "more 2 true",
  ]);
  const { shown, hidden } = shownRows(rows, false);
  expect([shown.length, hidden]).toEqual([QUIET_SHOWN + 1, 2]);
});

test("quiet projects wait behind one line per section that lists them under it, in their order", () => {
  const board = boardData([
    project("alpha", [row("local/a", { name: "alpha idle", status: "idle" })]),
    project("busy", [row("local/b", { name: "works" })]),
    project("gamma", [row("local/g", { name: "gamma idle", status: "unknown" })]),
    project("there", [row("lab/t", { name: "far idle", status: "idle" })]),
  ]);
  expect(shape(sidebarItems(board, two))).toEqual([
    "== This computer",
    "# busy",
    "works",
    "2 quiet shut",
    "== lab",
    "1 quiet shut",
  ]);
  expect(shape(sidebarItems(board, two, { quiet: ["machine:local"] }))).toEqual([
    "== This computer",
    "# busy",
    "works",
    "2 quiet open",
    "# alpha",
    "alpha idle",
    "# gamma",
    "gamma idle",
    "== lab",
    "1 quiet shut",
  ]);
});

test("a quiet project is active again the moment an agent of it works, waits, finished, is open or its machine is stale, and the others keep their order", () => {
  const read = (status: "idle" | "working" | "blocked" | "done") =>
    boardData([
      project("alpha", [row("local/a", { name: "alpha" })]),
      project("beta", [row("local/b", { name: "beta", status })]),
      project("gamma", [row("local/g", { name: "gamma" })]),
    ]);
  const heads = (items: SidebarItem[]) => shape(items).filter((s) => s.startsWith("#") || s.includes("quiet"));
  expect(heads(sidebarItems(read("idle"), one))).toEqual(["# alpha", "# gamma", "1 quiet shut"]);
  for (const status of ["working", "blocked", "done"] as const)
    expect(heads(sidebarItems(read(status), one))).toEqual(["# alpha", "# beta", "# gamma"]);
  expect(heads(sidebarItems(read("idle"), one, { open: ["local/b"] }))).toEqual(["# alpha", "# beta", "# gamma"]);
  const far = boardData([project("beta", [row("lab/b", { status: "idle" })])]);
  expect(heads(sidebarItems(far, [machine("local"), machine("lab", { state: "offline" })]))).toEqual(["# beta"]);
});

test("a pinned project never waits behind the quiet line: it was pinned to be seen", () => {
  const board = boardData([project("notes", [row("local/n", { name: "idle", status: "idle" })], { pinned: true })]);
  expect(shape(sidebarItems(board, one))).toEqual(["== Pinned", "# notes", "idle"]);
});

test("two projects of one name in one section show the end of their folder, and only then", () => {
  const board = boardData([
    project("research", [row("lab/a", { cwd: "/home/dev/research" })]),
    project("research", [row("lab/b", { cwd: "/home/dev/old" })], { key: "lab/workspace:research-old" }),
    project("research", [row("local/c", { cwd: "/home/dev/research" })]),
  ]);
  const heads = shape(sidebarItems(board, two)).filter((s) => s.startsWith("#"));
  expect(heads).toEqual(["# research", "# research ~/research", "# research ~/old"]);
  expect(folderTails(["/a/x/web", "/b/y/web"])).toEqual(["x/web", "y/web"]);
  expect(folderTails(["/home/dev/old", "/srv/old"])).toEqual(["~/old", "/srv/old"]);
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

test("a search finds agents and projects, also the folded, the quiet and the hidden idle ones, and ignores case and accents", () => {
  const board = boardData([
    project("api", [row("local/p1", { name: "Crème pipeline", status: "blocked" }), row("local/p2", { name: "docs" })]),
    project(
      "notes",
      [1, 2, 3, 4, 5].map((n) => row(`local/i${n}`, { name: n === 5 ? "old creme job" : "other", status: "idle" })),
    ),
  ]);
  // `notes` is quiet: without a search it waits behind the quiet line.
  expect(shape(sidebarItems(board, one)).at(-1)).toBe("1 quiet shut");
  const hits = shape(sidebarItems(board, one, { query: "CREME", folds: [board.projects[0].key] }));
  expect(hits).toEqual(["== This computer", "# api", "Crème pipeline", "# notes", "old creme job"]);
  expect(shape(sidebarItems(board, one, { query: "notes" }))).toEqual([
    "== This computer",
    "# notes",
    "other",
    "other",
    "other",
    "other",
    "old creme job",
  ]);
  expect(sidebarItems(board, one, { query: "nothing like it" })).toEqual([]);
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
  // a letter outside the basic plane is one letter, never half of one
  expect(monogram("𝔸lpha beta").letters).toBe("𝔸B");
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

test("a folded header says how many wait, nothing else; a card lists every part", () => {
  const mixed = { needsYou: 2, working: 1, toReview: 3 };
  expect(projectSummary(mixed, true)).toBe("2");
  expect(projectSummary(mixed, false)).toBe("2 waiting · 1 working · 3 to review");
  expect(projectSummary({ needsYou: 0, working: 2, toReview: 1 }, true)).toBe("");
  expect(projectSummary({ needsYou: 0, working: 0, toReview: 0 }, false)).toBe("");
});

test("a read of the board that changes nothing a line draws hands the list the very lines it had, and a change replaces only its own", () => {
  const read = (seconds: number, status: "working" | "done") =>
    boardData([
      project("api", [row("local/a1", { sinceSecs: seconds }), row("local/a2", { sinceSecs: seconds, status })]),
      project("web", [row("local/w1", { sinceSecs: seconds })]),
    ]);
  const first = keepItems([], sidebarItems(read(100, "working"), one));

  // Ten seconds later: the engine measured every age anew, and every line reads as before ("2 min").
  const later = keepItems(first, sidebarItems(read(110, "working"), one));
  expect(later.every((item, i) => item === first[i])).toBe(true);

  // An agent finishes: its line and its project's are new, the section's and the other project's are the same objects.
  const done = keepItems(later, sidebarItems(read(110, "done"), one));
  expect(shape(done)).toEqual(shape(later));
  expect(done.map((item, i) => item === later[i])).toEqual([true, false, true, false, true, true]);

  // An age that now reads differently is a change of that line (the section's line holds no age).
  const older = keepItems(done, sidebarItems(read(400, "done"), one));
  expect(older.slice(1).every((item, i) => item !== done[i + 1])).toBe(true);
});

test("projects keep the board's order until moved; a move up, down or to the top changes only its section", () => {
  const board = boardData([
    project("a", [row("local/a")]),
    project("b", [row("local/b")]),
    project("c", [row("local/c")]),
    project("far", [row("lab/f")]),
    project("near", [row("lab/n")]),
  ]);
  const heads = (order: Record<string, readonly string[]>) =>
    shape(sidebarItems(board, two, { order })).filter((s) => s.startsWith("#") || s.startsWith("=="));
  const at = (order: Record<string, readonly string[]>, name: string) =>
    sidebarItems(board, two, { order }).find(
      (i): i is Extract<SidebarItem, { kind: "project" }> => i.kind === "project" && i.project.name === name,
    )!;
  const step = (order: Record<string, readonly string[]>, name: string, to: "up" | "down" | "top") => {
    const item = at(order, name);
    return moveProject(board, order, {
      section: item.section,
      key: item.project.key,
      above: item.above,
      below: item.below,
      to,
    });
  };
  expect(heads({})).toEqual(["== This computer", "# a", "# b", "# c", "== lab", "# far", "# near"]);
  const up = step({}, "c", "up");
  expect(heads(up)).toEqual(["== This computer", "# a", "# c", "# b", "== lab", "# far", "# near"]);
  const down = step(up, "a", "down");
  expect(heads(down)).toEqual(["== This computer", "# c", "# a", "# b", "== lab", "# far", "# near"]);
  const top = step(down, "b", "top");
  expect(heads(top)).toEqual(["== This computer", "# b", "# c", "# a", "== lab", "# far", "# near"]);
  // The ends: nothing above the first, nothing below the last; the order object is the same one.
  expect(step(top, "b", "up")).toBe(top);
  expect(step(top, "b", "top")).toBe(top);
  expect(step(top, "a", "down")).toBe(top);
  expect(at(top, "b").above).toBeNull();
  expect(at(top, "a").below).toBeNull();
});

test("a project the person never placed appears at the top of its section, above the placed ones", () => {
  const before = boardData([project("a", [row("local/a")]), project("b", [row("local/b")])]);
  const item = sidebarItems(before, one).find(
    (i): i is Extract<SidebarItem, { kind: "project" }> => i.kind === "project" && i.project.name === "a",
  )!;
  const order = moveProject(
    before,
    {},
    { section: item.section, key: item.project.key, above: item.above, below: item.below, to: "down" },
  );
  const after = boardData([...before.projects, project("new", [row("local/n")])]);
  const heads = shape(sidebarItems(after, one, { order })).filter((s) => s.startsWith("#"));
  expect(heads).toEqual(["# new", "# b", "# a"]);
  expect(arrange(["x", "y", "z"], (k) => k, ["z", "x"])).toEqual(["y", "z", "x"]);
});

test("the footer names the machines whose link is an exception, never an online or a switched-off one", () => {
  const all = [
    machine("local"),
    machine("a", { state: "offline" }),
    machine("b", { state: "off" }),
    machine("c", { state: "attention" }),
  ];
  expect(footerMachines(all, false).lines.map((m) => m.id)).toEqual(["a", "c"]);
  expect(footerMachines([machine("local")], false)).toEqual({ lines: [], more: 0 });
});

test("the footer folds machines past three into one line, but never folds a single one away", () => {
  const down = (n: number) => Array.from({ length: n }, (_, i) => machine(`m${i}`, { state: "offline" }));
  expect(footerMachines(down(4), false)).toMatchObject({ more: 0 });
  expect(footerMachines(down(4), false).lines).toHaveLength(4);
  const folded = footerMachines(down(6), false);
  expect(folded.lines).toHaveLength(3);
  expect(folded.more).toBe(3);
  expect(footerMachines(down(6), true)).toMatchObject({ more: 0 });
});
