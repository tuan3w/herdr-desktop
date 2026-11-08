import { expect, test } from "nsh/test";

import type { BoardProject } from "herdr-desktop/native";
import type { DockAreaLayout } from "nsh/base";

import {
  activate,
  BOARD,
  bucket,
  changesKey,
  companionOf,
  CONTEXT_CAP,
  type Contexts,
  defaultLayout,
  emptyLayout,
  groupOf,
  groups,
  HOME,
  layoutOf,
  otherGroup,
  panelsOf,
  paneKey,
  parsePaneKey,
  projectOfFolder,
  parseSessionKey,
  readDock,
  readLayout,
  restoreFocus,
  rowKeyOf,
  sessionKey,
  withoutPanels,
  withPanel,
  withSplit,
  writeDock,
} from "#lib/dock";

const A = paneKey("local", "w1:p1");
const B = paneKey("m1", "w2:p3");

const split = (...cols: string[][]): DockAreaLayout => ({
  center: { type: "split", axis: "horizontal", children: cols.map((panels) => ({ type: "tabs", panels })) },
});

test("a pane key reads back to its machine and pane, ids with colons included, and nothing else is a pane", () => {
  expect(parsePaneKey(A)).toEqual({ machine: "local", pane: "w1:p1" });
  expect(parsePaneKey(B)).toEqual({ machine: "m1", pane: "w2:p3" });
  expect(parsePaneKey(BOARD)).toBeNull();
  expect(parsePaneKey("pane:local/")).toBeNull();
  expect(parsePaneKey("pane:/w1:p1")).toBeNull();
});

test("a saved layout is reopened as it was, split sizes and the displayed tab included", () => {
  const saved = JSON.stringify({
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: [BOARD, A], activeIndex: 1 },
        { type: "tabs", panels: [B], activeIndex: 0 },
      ],
      sizes: [500, null],
    },
  });
  const layout = readLayout(saved);
  expect(groups(layout).map((g) => [g.panels, g.active])).toEqual([
    [[BOARD, A], 1],
    [[B], 0],
  ]);
  expect(layout.center).toMatchObject({ sizes: [500, null] });
});

test("a damaged or foreign file never breaks the start: the board alone opens", () => {
  for (const raw of [null, "", "not json", "{}", '{"center":7}', '{"center":{"type":"tabs","panels":[]}}']) {
    expect(readLayout(raw)).toEqual(defaultLayout());
  }
});

test("tabs for things that cannot be opened are dropped, a tab listed twice keeps its first place, empty groups go", () => {
  const saved = JSON.stringify({
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: [BOARD, "settings", A, A, 5] },
        { type: "tabs", panels: ["files", A] },
        { type: "bogus" },
      ],
    },
  });
  expect(groups(readLayout(saved)).map((g) => g.panels)).toEqual([[BOARD, A]]);
});

test("the board is put back at the front when the saved layout lost it, and the displayed tab stays the same one", () => {
  const layout = readLayout(JSON.stringify(split([A, B])));
  expect(groups(layout)).toEqual([{ id: undefined, panels: [BOARD, A, B], active: 1 }]);
});

test("a layout with only a tab group at its root still opens as a split", () => {
  const layout = readLayout(JSON.stringify({ center: { type: "tabs", panels: [BOARD, A] } }));
  expect(layout.center.type).toBe("split");
  expect(panelsOf(layout)).toEqual([BOARD, A]);
});

test("the other group is the next one in reading order, wrapping, and absent when there is only one", () => {
  const layout = split([BOARD], [A], [B]);
  expect(otherGroup(layout, BOARD)?.panels).toEqual([A]);
  expect(otherGroup(layout, B)?.panels).toEqual([BOARD]);
  expect(otherGroup(split([BOARD, A]), A)).toBeUndefined();
  expect(groupOf(layout, B)?.panels).toEqual([B]);
  expect(groupOf(layout, "pane:gone/x")).toBeUndefined();
});

test("groups are read through nested splits left to right, top to bottom", () => {
  const layout: DockAreaLayout = {
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: [BOARD] },
        {
          type: "split",
          axis: "vertical",
          children: [
            { type: "tabs", panels: [A] },
            { type: "tabs", panels: [B] },
          ],
        },
      ],
    },
  };
  expect(panelsOf(layout)).toEqual([BOARD, A, B]);
});

test("a chat tab reads back to its machine and session, and every kind of tab names the one board row it is about", () => {
  const keeper = sessionKey("local", "abc234");
  const observed = sessionKey("local", "pane:w1:p1");
  expect(parseSessionKey(keeper)).toEqual({ machine: "local", id: "abc234" });
  expect(parseSessionKey(observed)).toEqual({ machine: "local", id: "pane:w1:p1" });
  expect(parseSessionKey(A)).toBeNull();
  expect(parsePaneKey(keeper)).toBeNull();
  expect(rowKeyOf(A)).toBe("local/w1:p1");
  // The terminal and the chat read from it are two views of one agent: one row.
  expect(rowKeyOf(observed)).toBe("local/w1:p1");
  expect(rowKeyOf(keeper)).toBe("local/session:abc234");
  expect(rowKeyOf(BOARD)).toBeNull();
});

test("saved chat tabs reopen with the layout, next to the terminals", () => {
  const chat = sessionKey("local", "pane:w1:p1");
  const layout = readLayout(JSON.stringify(split([BOARD, A, chat])));
  expect(panelsOf(layout)).toEqual([BOARD, A, chat]);
});

// ---- contexts ----

const C = paneKey("local", "w1:p3");
const doc = (extra: Partial<Contexts> = {}): Contexts => ({
  current: HOME,
  contexts: { [HOME]: { layout: defaultLayout(), focused: BOARD, savedAt: 1 } },
  strays: [],
  ...extra,
});

test("a project's layout never holds the board and may hold nothing; the home's always holds the board", () => {
  const both = { center: { type: "split", axis: "horizontal", children: [{ type: "tabs", panels: [BOARD, A] }] } };
  expect(panelsOf(layoutOf(both, false))).toEqual([A]);
  expect(panelsOf(layoutOf(both, true))).toEqual([BOARD, A]);
  expect(layoutOf({ center: { type: "tabs", panels: [BOARD] } }, false)).toEqual(emptyLayout());
  expect(layoutOf("junk", false)).toEqual(emptyLayout());
  expect(layoutOf("junk", true)).toEqual(defaultLayout());
});

test("the saved layouts come back: the context shown, each layout, the tab each was left in, the waiting panels", () => {
  const written = writeDock(
    doc({
      current: "local/pay",
      contexts: {
        [HOME]: { layout: defaultLayout(), focused: BOARD, savedAt: 1 },
        "local/pay": { layout: split([A, C]), focused: C, savedAt: 5 },
        "local/web": { layout: emptyLayout(), focused: "", savedAt: 3 },
      },
      strays: [B],
    }),
  );
  const read = readDock(written)!;
  expect(read.current).toBe("local/pay");
  expect(panelsOf(read.contexts["local/pay"].layout)).toEqual([A, C]);
  expect(read.contexts["local/pay"].focused).toBe(C);
  expect(panelsOf(read.contexts["local/web"].layout)).toEqual([]);
  expect(read.contexts["local/web"].focused).toBe("");
  expect(panelsOf(read.contexts[HOME].layout)).toEqual([BOARD]);
  expect(read.strays).toEqual([B]);
});

test("a file that is not the second version, or is damaged, is not read (the first version's is tried), and a context shown that is gone opens the home", () => {
  expect(readDock(null)).toBeNull();
  expect(readDock("not json")).toBeNull();
  expect(readDock(JSON.stringify({ center: {} }))).toBeNull();
  expect(readDock(JSON.stringify({ v: 3 }))).toBeNull();
  const odd = readDock(
    JSON.stringify({ v: 2, current: "local/nope", home: 7, contexts: { x: "junk" }, strays: [1, "junk", B] }),
  )!;
  expect(odd.current).toBe(HOME);
  expect(panelsOf(odd.contexts[HOME].layout)).toEqual([BOARD]);
  expect(panelsOf(odd.contexts.x.layout)).toEqual([]);
  expect(odd.strays).toEqual([B]);
});

test("only the newest sixty contexts are kept, the shown one among them whatever its age", () => {
  const contexts: Contexts["contexts"] = { [HOME]: { layout: defaultLayout(), focused: BOARD, savedAt: 1 } };
  for (let i = 0; i < CONTEXT_CAP + 10; i++)
    contexts[`p${i}`] = { layout: emptyLayout(), focused: "", savedAt: 100 + i };
  const read = readDock(writeDock({ current: "p0", contexts, strays: [] }))!;
  const keys = Object.keys(read.contexts).filter((k) => k !== HOME);
  expect(keys).toHaveLength(CONTEXT_CAP);
  expect(keys).toContain("p0");
  expect(keys).toContain(`p${CONTEXT_CAP + 9}`);
  expect(keys).not.toContain("p1");
  expect(read.current).toBe("p0");
});

test("a layout of the first version is split by project: each project's panels become its layout, the rest stay home", () => {
  const home = split([BOARD, A, B, C]);
  const project = (panel: string) => ({ [A]: "pay", [C]: "pay", [B]: undefined })[panel];
  const out = bucket(home, project);
  expect(panelsOf(out.home)).toEqual([BOARD, B]);
  expect(panelsOf(out.projects.pay)).toEqual([A, C]);
  expect(out.strays).toEqual([B]);
  expect(Object.keys(out.projects)).toEqual(["pay"]);
});

test("a tab joins the group of the one beside it, an empty layout gets a group, and the new tab is the displayed one", () => {
  const two = split([BOARD, A], [B]);
  const joined = withPanel(two, C, B);
  expect(groups(joined).map((g) => [g.panels, g.active])).toEqual([
    [[BOARD, A], 0],
    [[B, C], 1],
  ]);
  expect(groups(withPanel(two, C)).map((g) => g.panels)).toEqual([[BOARD, A, C], [B]]);
  expect(groups(withPanel(emptyLayout(), C)).map((g) => [g.panels, g.active])).toEqual([[[C], 0]]);
  // A panel already there is only displayed.
  expect(groups(withPanel(two, A)).map((g) => g.active)).toEqual([1, 0]);
});

test("taking tabs out leaves the displayed one where it was, drops what is empty and may leave nothing", () => {
  const layout = split([BOARD, A, B], [C]);
  const shown = activate(layout, B);
  expect(groups(withoutPanels(shown, new Set([A]))).map((g) => [g.panels, g.active])).toEqual([
    [[BOARD, B], 1],
    [[C], 0],
  ]);
  expect(groups(withoutPanels(layout, new Set([C]))).map((g) => g.panels)).toEqual([[BOARD, A, B]]);
  expect(withoutPanels(split([A]), new Set([A]))).toEqual(emptyLayout());
});

test("the tab a layout comes back to is the one asked for, else the board of the home, else what its first group shows, else none", () => {
  const layout = activate(split([A, B]), B);
  expect(restoreFocus(layout, A, false)).toBe(A);
  expect(restoreFocus(layout, "pane:local/gone", false)).toBe(B);
  expect(restoreFocus(split([BOARD, A]), "pane:local/gone", true)).toBe(BOARD);
  expect(restoreFocus(emptyLayout(), A, false)).toBe("");
});

// macOS: git names a checkout by its real path (`/private/var/...`), a tab or an agent may hold the link (`/var/...`).
const real = (_machine: string, path: string) => (path.startsWith("/var/") ? `/private${path}` : path);
const project = (key: string, checkouts: string[], cwds: string[] = [], machine = "local") =>
  ({
    key,
    machine,
    checkouts: checkouts.map((path) => ({ path, name: path, linked: false })),
    rows: cwds.map((cwd) => ({ cwd })),
  }) as unknown as BoardProject;

test("a folder reached by a link finds the project whose checkout is its real path, and the other way round", () => {
  const projects = [project("local/a", ["/private/var/x/"]), project("local/b", ["/var/y"])];
  expect(projectOfFolder(projects, "local", "/var/x/src", real)).toBe("local/a");
  expect(projectOfFolder(projects, "local", "/private/var/y", real)).toBe("local/b");
  // An agent's own folder is a checkout too.
  expect(projectOfFolder([project("local/c", [], ["/var/z"])], "local", "/private/var/z", real)).toBe("local/c");
});

test("a folder in no project, or only in another machine's, finds none", () => {
  const projects = [project("m1/a", ["/var/x"], [], "m1")];
  expect(projectOfFolder(projects, "local", "/var/x", real)).toBeNull();
  expect(projectOfFolder([project("local/a", ["/var/x"])], "local", "/var/xy", real)).toBeNull();
});

const CHAT = sessionKey("local", "pane:w1:p1");
const KEEPER = sessionKey("local", "abc234");
const CHANGES = changesKey("local", "/src/pay");
const why = (c: { key: string } | { why: string }): string => ("why" in c ? c.why : "");

test("a chat in a git folder has its Changes as companion, else the terminal of its pane, else nothing to show and why", () => {
  expect(companionOf(CHAT, { cwd: "/src/pay", repo: true })).toEqual({ key: CHANGES });
  expect(companionOf(CHAT, { cwd: "/src/pay", repo: false })).toEqual({ key: paneKey("local", "w1:p1") });
  expect(companionOf(CHAT, { repo: false })).toEqual({ key: paneKey("local", "w1:p1") });
  // A keeper's session has no pane: outside a repository there is nothing to put beside it.
  expect(why(companionOf(KEEPER, { cwd: "/tmp/x", repo: false }))).toContain("git");
});

test("a Changes tab has its folder's agent as companion; a terminal has Changes or its chat; the board has none", () => {
  expect(companionOf(CHANGES, { repo: true, view: CHAT })).toEqual({ key: CHAT });
  expect(why(companionOf(CHANGES, { repo: true }))).toContain("agent");
  expect(companionOf(A, { cwd: "/src/pay", repo: true, view: CHAT })).toEqual({ key: changesKey("local", "/src/pay") });
  expect(companionOf(A, { cwd: "/src/pay", repo: false, view: CHAT })).toEqual({ key: CHAT });
  expect(why(companionOf(BOARD, { repo: true }))).toContain("board");
});

test("a chat split beside its Changes is saved and comes back as the same two groups", () => {
  const layout: DockAreaLayout = {
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: [CHAT], activeIndex: 0 },
        { type: "tabs", panels: [CHANGES], activeIndex: 0 },
      ],
      sizes: [640, null],
    },
  };
  const doc: Contexts = {
    current: "local/pay",
    contexts: {
      [HOME]: { layout: defaultLayout(), focused: BOARD, savedAt: 1 },
      "local/pay": { layout, focused: CHANGES, savedAt: 2 },
    },
    strays: [],
  };
  const back = readDock(writeDock(doc))!;
  expect(groups(back.contexts["local/pay"].layout).map((g) => g.panels)).toEqual([[CHAT], [CHANGES]]);
  expect(back.contexts["local/pay"].layout.center).toMatchObject({ sizes: [640, null] });
  expect(back.contexts["local/pay"].focused).toBe(CHANGES);
});

test("a view split off beside a group becomes a group of its own: next to it in a split that runs the same way, else in a split around it", () => {
  const one = withSplit(split([A]), B, A, "right");
  expect(groups(one).map((g) => g.panels)).toEqual([[A], [B]]);
  const three = withSplit(one, CHANGES, A, "right");
  expect(groups(three).map((g) => g.panels)).toEqual([[A], [CHANGES], [B]]);
  const down = withSplit(split([A], [B]), CHANGES, B, "bottom");
  expect(groups(down).map((g) => g.panels)).toEqual([[A], [B], [CHANGES]]);
  expect(down.center).toMatchObject({ children: [{ type: "tabs" }, { type: "split", axis: "vertical" }] });
  // A view that was a tab of the group leaves it, and the group that held it alone is not left behind empty.
  expect(groups(withSplit(split([A, B]), B, A, "right")).map((g) => g.panels)).toEqual([[A], [B]]);
  expect(groups(withSplit(emptyLayout(), A, "none", "right")).map((g) => g.panels)).toEqual([[A]]);
});
