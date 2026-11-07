import { expect, test } from "nsh/test";
import type { BoardData, BoardRow } from "herdr-desktop/native";
import { ageText, matches, rowLabel, sidebarItems } from "./sidebar";

function row(key: string, over: Partial<BoardRow> = {}): BoardRow {
  const [machine, paneId] = key.split("/");
  return {
    key,
    machine,
    machineName: machine === "local" ? "This computer" : machine,
    paneId,
    workspaceId: "w1",
    tabId: "w1:t1",
    agent: "claude",
    name: `agent ${paneId}`,
    status: "working",
    offline: false,
    reviewed: false,
    reviewKey: `${key}|1`,
    preview: [],
    ...over,
  };
}

function data(over: Partial<BoardData> = {}): BoardData {
  return {
    needsYou: [],
    toReview: [],
    working: [],
    idle: [],
    idleRest: [],
    moreIdle: 0,
    counts: { needsYou: 0, toReview: 0, working: 0, idle: 0, offline: 0, machinesNotConnected: 0 },
    statusLine: "",
    title: "Herdr Desktop",
    revision: 1,
    ...over,
  };
}

const kinds = (items: ReturnType<typeof sidebarItems>) => items.map((i) => (i.kind === "row" ? i.row.name : i.kind === "header" ? `# ${i.title} ${i.count}` : `more ${i.count} ${i.open}`));

test("sections follow the board's order, empty ones are left out and Needs you is never foldable", () => {
  const board = data({
    needsYou: [row("local/p1", { name: "blocked one", status: "blocked" })],
    working: [row("local/p2", { name: "busy one" })],
    idle: [row("local/p3", { name: "quiet one", status: "idle" })],
  });
  expect(kinds(sidebarItems(board, "", [], false))).toEqual(["# Needs you 1", "blocked one", "# Working 1", "busy one", "# Idle 1", "quiet one"]);
  const needs = sidebarItems(board, "", ["working", "idle"], false)[0];
  expect(needs).toMatchObject({ kind: "header", foldable: false, folded: false });
});

test("a folded section keeps its header and count and hides its rows", () => {
  const board = data({ working: [row("local/p2"), row("local/p4")] });
  expect(kinds(sidebarItems(board, "", ["working"], false))).toEqual(["# Working 2"]);
});

test("the idle agents beyond the five newest sit behind one line that opens and closes them", () => {
  const five = [1, 2, 3, 4, 5].map((n) => row(`local/i${n}`, { name: `idle ${n}`, status: "idle" }));
  const rest = [6, 7].map((n) => row(`local/i${n}`, { name: `idle ${n}`, status: "idle" }));
  const board = data({ idle: five, idleRest: rest });
  const closed = kinds(sidebarItems(board, "", [], false));
  expect(closed.slice(-2)).toEqual(["idle 5", "more 2 false"]);
  const open = kinds(sidebarItems(board, "", [], true));
  expect(open.slice(-3)).toEqual(["idle 6", "idle 7", "more 2 true"]);
});

test("a search finds agents in every section, also the hidden idle ones, and ignores case and accents", () => {
  const board = data({
    needsYou: [row("local/p1", { name: "Crème pipeline", status: "blocked" })],
    working: [row("local/p2", { name: "docs" })],
    idle: [row("local/i1", { name: "other", status: "idle" })],
    idleRest: [row("local/i9", { name: "old creme job", status: "idle" })],
  });
  expect(kinds(sidebarItems(board, "CREME", [], false))).toEqual(["# Needs you 1", "Crème pipeline", "# Idle 1", "old creme job"]);
  expect(sidebarItems(board, "nothing like it", [], false)).toEqual([]);
});

test("a search narrows by every word, over name, agent, machine and folder", () => {
  const r = row("m1/p1", { name: "api fix", agent: "codex", cwd: "/home/dev/payments" });
  expect(matches(r, "codex payments")).toBe(true);
  expect(matches(r, "codex billing")).toBe(false);
  expect(matches(r, "m1 api")).toBe(true);
  expect(matches(r, "   ")).toBe(true);
});

test("a screen reader hears name, agent, state, machine and how long, and that the state may be old", () => {
  const r = row("local/p1", { name: "api fix", status: "blocked", sinceSecs: 130 });
  expect(rowLabel(r)).toBe("api fix, claude, needs you, This computer, 2 min");
  expect(rowLabel(row("local/p1", { name: "api fix", agent: "", offline: true, status: "idle" }))).toBe("api fix, idle, This computer, offline");
});

test("ages read as a glance wants them", () => {
  expect([null, 10, 90, 3500, 7300, 200000].map(ageText)).toEqual(["", "just now", "2 min", "58 min", "2 h", "2 d"]);
});
