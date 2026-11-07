import { expect, test } from "nsh/test";
import type { BoardData, BoardRow } from "herdr-desktop/native";
import { boardItems } from "./board-items";

const row = (pane: string, over: Partial<BoardRow> = {}): BoardRow => ({
  key: `local/${pane}`,
  machine: "local",
  machineName: "This computer",
  paneId: pane,
  workspaceId: "w1",
  tabId: "w1:t1",
  agent: "claude",
  name: pane,
  status: "working",
  offline: false,
  reviewed: false,
  reviewKey: `local|${pane}|1`,
  preview: [],
  ...over,
});

const data = (over: Partial<BoardData> = {}): BoardData => ({
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
});

const shape = (items: ReturnType<typeof boardItems>) => items.map((i) => (i.kind === "header" ? `# ${i.title}` : i.kind === "more" ? `+ ${i.text}` : `${i.kind} ${i.key}`));

test("sections come in the order of urgency, empty ones have no header, and a reachable waiting agent is a card", () => {
  const items = boardItems(
    data({
      needsYou: [row("a", { status: "blocked" }), row("b", { status: "blocked", offline: true })],
      working: [row("c")],
      toReview: [row("d", { status: "done" })],
    }),
    [],
    false,
  );
  expect(shape(items)).toEqual(["# Needs you", "card local/a", "row local/b", "# To review", "row local/d", "# Working", "row local/c"]);
});

test("a folded section keeps its header and hides its rows, and what needs you can never be folded", () => {
  const items = boardItems(data({ needsYou: [row("a", { status: "blocked" })], working: [row("c")] }), ["working", "needsYou"], false);
  expect(shape(items)).toEqual(["# Needs you", "card local/a", "# Working"]);
});

test("offline agents that wait are said, not counted: the header notes them", () => {
  const items = boardItems(data({ needsYou: [row("a", { status: "blocked", offline: true }), row("b", { status: "blocked", offline: true })] }), [], false);
  expect(items[0]).toMatchObject({ kind: "header", note: "2 offline" });
});

test("idle shows five, the rest hide behind one line naming the first two, and opening lists them all in place", () => {
  const idle = ["i1", "i2", "i3", "i4", "i5"].map((p) => row(p, { status: "idle", name: p }));
  const rest = ["r1", "r2", "r3"].map((p) => row(p, { status: "idle", name: `agent ${p}` }));
  const closed = boardItems(data({ idle, idleRest: rest, moreIdle: 3, counts: { needsYou: 0, toReview: 0, working: 0, idle: 8, offline: 0, machinesNotConnected: 0 } }), [], false);
  expect(shape(closed).slice(-2)).toEqual(["row local/i5", "+ 3 more idle: agent r1, agent r2…"]);
  expect(closed[0]).toMatchObject({ kind: "header", title: "Idle", note: "8" });

  const open = boardItems(data({ idle, idleRest: rest, moreIdle: 3 }), [], true);
  expect(shape(open).slice(-4)).toEqual(["row local/r1", "row local/r2", "row local/r3", "+ Show less"]);
  expect(open.filter((i) => i.kind === "row")).toHaveLength(8);
});

test("a folded idle section hides the line that opens it as well", () => {
  const items = boardItems(data({ idle: [row("i1", { status: "idle" })], idleRest: [row("r1", { status: "idle" })], moreIdle: 1 }), ["idle"], false);
  expect(shape(items)).toEqual(["# Idle"]);
});
