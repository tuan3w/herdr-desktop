import { expect, test } from "nsh/test";
import type { SessionItem, ToolStatusName } from "herdr-desktop/native";
import { buildRows, type Row, type RowInput, spanSeconds, unitStart } from "./session-rows";

let next = 1;
const say = (role: "user" | "agent" | "thought", text: string): SessionItem => ({ id: next++, rev: 1, kind: "message", role, text, images: [], parts: [] });
const tool = (title: string, status: ToolStatusName = "completed", toolKind = "execute"): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "tool",
  images: [],
  parts: [],
  tool: { id: `t${next}`, title, toolKind, status, subject: title, head: [], tail: [], omitted: 0, diffs: [], locations: [], parts: [], terminal: false },
});

const input = (items: SessionItem[], over: Partial<RowInput> = {}): RowInput => ({
  items,
  earlier: null,
  running: false,
  open: new Map(),
  nowMs: null,
  ...over,
});

const kinds = (rows: readonly Row[]) => rows.map((r) => r.kind);

test("a finished turn folds its calls into one line between what was asked and what was answered", () => {
  const items = [say("user", "fix it"), tool("ls"), tool("cargo test"), say("thought", "hm"), say("agent", "Done.")];
  const rows = buildRows(input(items));
  expect(kinds(rows)).toEqual(["user", "work", "agent"]);
  const work = rows[1]!;
  if (work.kind !== "work") throw new Error("not a group");
  expect(work.work.summary.steps).toBe(3);
  expect(work.work.summary.commands).toBe(2);
  expect(work.work.open).toBe(false);
});

test("the group the agent is working in is open while the turn runs, and folds when it ends", () => {
  const items = [say("user", "go"), tool("ls", "completed"), tool("cargo test", "inProgress")];
  const running = buildRows(input(items, { running: true }));
  expect(kinds(running)).toEqual(["user", "work", "tool", "tool"]);
  const over = buildRows(input(items, { running: false }));
  expect(kinds(over)).toEqual(["user", "work"]);
});

test("a choice of the person beats the default either way", () => {
  const items = [say("user", "go"), tool("ls"), say("agent", "ok")];
  const group = buildRows(input(items))[1]!;
  const opened = buildRows(input(items, { open: new Map([[group.key, true]]) }));
  expect(kinds(opened)).toEqual(["user", "work", "tool", "agent"]);
  const live = [say("user", "go"), tool("ls", "inProgress")];
  const key = buildRows(input(live, { running: true }))[1]!.key;
  expect(kinds(buildRows(input(live, { running: true, open: new Map([[key, false]]) })))).toEqual(["user", "work"]);
});

test("narration between calls stays visible and splits the work into two groups", () => {
  const items = [say("user", "go"), tool("a"), say("agent", "now the tests"), tool("b")];
  expect(kinds(buildRows(input(items)))).toEqual(["user", "work", "agent", "work"]);
});

test("a row that did not change is the same object, so the list rebinds only what moved", () => {
  const items = [say("user", "go"), say("agent", "one"), say("user", "two"), say("agent", "partial")];
  const first = buildRows(input(items));
  const grown = [...items.slice(0, 3), { ...items[3]!, rev: 2, text: "partial text" }];
  const second = buildRows(input(grown), new Map(first.map((r) => [r.key, r])));
  expect(second[0]).toBe(first[0]);
  expect(second[2]).toBe(first[2]);
  expect(second[3]).not.toBe(first[3]);
});

test("an agent message with nothing in it yet draws no row, and a kind nobody knows draws a quiet one", () => {
  const strange = { id: next++, rev: 1, kind: "hologram", text: "x" } as unknown as SessionItem;
  const rows = buildRows(input([say("user", "hi"), say("agent", "  "), strange]));
  expect(kinds(rows)).toEqual(["user", "other"]);
});

test("the last agent message is live only while a turn runs", () => {
  const items = [say("user", "hi"), say("agent", "typing")];
  const live = buildRows(input(items, { running: true }))[1]!;
  const done = buildRows(input(items))[1]!;
  expect(live.kind === "agent" && live.live).toBe(true);
  expect(done.kind === "agent" && done.live).toBe(false);
});

test("a range builds only its own part, and the notice about earlier turns belongs to the top", () => {
  const items = [say("user", "a"), say("agent", "b"), say("user", "c"), say("agent", "d")];
  const all = buildRows(input(items, { earlier: "Earlier messages are no longer kept" }));
  expect(kinds(all)[0]).toBe("earlier");
  const tail = buildRows(input(items, { earlier: "x" }), undefined, { from: 2, to: 4 });
  expect(kinds(tail)).toEqual(["user", "agent"]);
  expect(unitStart([tool("a"), tool("b"), say("agent", "x"), tool("c"), tool("d")], 4)).toBe(3);
});

test("a call that starts another agent stands outside the fold, as its own line", () => {
  const items = [say("user", "split it"), tool("ls"), tool("tax-rules", "inProgress", "task"), tool("cargo test")];
  expect(kinds(buildRows(input(items)))).toEqual(["user", "work", "subagent", "work"]);
});

test("how long a group took comes from the agent's own times: to its last call's end, else the next row, else now; a replay has none", () => {
  const at = (item: SessionItem, startedMs: number, endedMs?: number): SessionItem => ({ ...item, startedMs, endedMs });
  const a = at(tool("ls"), 1000, 2500);
  const b = at(tool("cargo test"), 2500, 5200);
  const reply = at(say("agent", "ok"), 5300);
  expect(spanSeconds(a, b, reply, null)).toBe(4);
  // The last call is still running: the span runs to the session's clock now.
  const live = at(tool("npm test", "inProgress"), 6000);
  expect(spanSeconds(live, live, undefined, 14_000)).toBe(8);
  // Under a second says nothing; no start (a replay) says nothing.
  expect(spanSeconds(at(tool("x"), 100, 400), at(tool("x"), 100, 400), undefined, null)).toBeNull();
  expect(spanSeconds(tool("replayed"), tool("replayed"), undefined, 9000)).toBeNull();

  const rows = buildRows(input([say("user", "go"), a, b, reply]));
  const group = rows[1]!;
  expect(group.kind === "work" && group.work.seconds).toBe(4);
});
