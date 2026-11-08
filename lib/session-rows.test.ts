import { expect, test } from "nsh/test";

import type { SessionItem, ToolItem, ToolStatusName } from "herdr-desktop/native";

import { buildRows, type Row, type RowInput, spanSeconds, type TurnCarry, unitStart } from "#lib/session-rows";

let next = 1;
const say = (role: "user" | "agent" | "thought", text: string): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "message",
  role,
  text,
  images: [],
  parts: [],
});
const tool = (
  title: string,
  status: ToolStatusName = "completed",
  toolKind = "execute",
  over: Partial<ToolItem> = {},
): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "tool",
  images: [],
  parts: [],
  tool: {
    id: `t${next}`,
    title,
    toolKind,
    status,
    subject: title,
    head: [],
    tail: [],
    omitted: 0,
    diffs: [],
    locations: [],
    parts: [],
    terminal: false,
    ...over,
  },
});
const edit = (path: string, added: number, removed: number): SessionItem =>
  tool(`Edit ${path}`, "completed", "edit", { subject: path, diffs: [{ path, old: "a", new: "b", added, removed }] });
const push = (): SessionItem =>
  tool("git push", "completed", "execute", { effect: { kind: "push", text: "Pushed to origin/main" } });

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

test("the group the agent is working in is one line while the turn runs too: the live line says what it does now", () => {
  const items = [say("user", "go"), tool("ls", "completed"), tool("cargo test", "inProgress")];
  expect(kinds(buildRows(input(items, { running: true })))).toEqual(["user", "work"]);
  expect(kinds(buildRows(input(items, { running: false })))).toEqual(["user", "work"]);
});

test("a choice of the person beats the default either way", () => {
  const items = [say("user", "go"), tool("ls"), say("agent", "ok")];
  const group = buildRows(input(items))[1]!;
  const opened = buildRows(input(items, { open: new Map([[group.key, true]]) }));
  expect(kinds(opened)).toEqual(["user", "work", "tool", "agent"]);
  const live = [say("user", "go"), tool("ls", "inProgress")];
  const key = buildRows(input(live, { running: true }))[1]!.key;
  expect(kinds(buildRows(input(live, { running: true, open: new Map([[key, true]]) })))).toEqual([
    "user",
    "work",
    "tool",
  ]);
});

test("narration between calls folds with them: only the turn's last message stays on the page", () => {
  const items = [say("user", "go"), tool("a"), say("agent", "now the tests"), tool("b"), say("agent", "All green.")];
  const rows = buildRows(input(items));
  expect(kinds(rows)).toEqual(["user", "work", "agent"]);
  const open = buildRows(input(items, { open: new Map([[rows[1]!.key, true]]) }));
  expect(kinds(open)).toEqual(["user", "work", "tool", "narration", "tool", "agent"]);
});

test("the unit a streaming message belongs to becomes a group when a call follows it", () => {
  const items = [say("user", "go"), tool("a"), say("agent", "now")];
  expect(unitStart(items, 2)).toBe(2);
  expect(unitStart([...items, tool("b")], 3)).toBe(1);
});

test("a finished turn's end-of-turn item draws nothing; a failed turn says so", () => {
  const ok = { ...say("agent", ""), kind: "done", text: "Done in 41s", ok: true } as SessionItem;
  const bad = { ...say("agent", ""), kind: "done", text: "Turn failed", ok: false } as SessionItem;
  expect(kinds(buildRows(input([say("user", "go"), say("agent", "yes"), ok])))).toEqual(["user", "agent"]);
  expect(kinds(buildRows(input([say("user", "go"), say("agent", "yes"), bad])))).toEqual(["user", "agent", "note"]);
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
  expect(unitStart([tool("a"), tool("b"), say("user", "x"), tool("c"), tool("d")], 4)).toBe(3);
});

test("a call that starts another agent stands outside the fold, as its own line", () => {
  const items = [say("user", "split it"), tool("ls"), tool("tax-rules", "inProgress", "task"), tool("cargo test")];
  expect(kinds(buildRows(input(items)))).toEqual(["user", "work", "subagent", "work"]);
});

test("how long a thought took comes from the agent's own times: to its last call's end, else the next row, else now; a replay has none", () => {
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
});

const effectsOf = (rows: readonly Row[]) => {
  const row = rows.find((r) => r.kind === "effects");
  return row && row.kind === "effects" ? row.effects : null;
};

test("a push after reads and edits is visible while the reads and edits fold", () => {
  const items = [
    say("user", "ship it"),
    tool("Read a.ts", "completed", "read"),
    edit("src/a.ts", 12, 4),
    edit("src/b.ts", 0, 0),
    push(),
    say("agent", "Pushed."),
  ];
  const rows = buildRows(input(items));
  expect(kinds(rows)).toEqual(["user", "work", "agent", "effects"]);
  const fx = effectsOf(rows)!;
  expect(fx.external.map((e) => e.text)).toEqual(["Pushed to origin/main"]);
  expect(fx.edited).toEqual({ files: 2, added: 12, removed: 4 });
  expect(fx.failures).toEqual([]);
});

test("a failed call is always shown with the last line it printed, and never an invented exit code", () => {
  const failed = tool("Run: pnpm test", "failed", "execute", {
    subject: "pnpm test",
    tail: ["FAIL src/case-9.test.ts", "1 failed, 39 passed"],
  });
  const fx = effectsOf(buildRows(input([say("user", "go"), failed, say("agent", "It failed.")])))!;
  expect(fx.failures).toHaveLength(1);
  expect(fx.failures[0]!.result).toBe("1 failed, 39 passed");
  expect(JSON.stringify(fx)).not.toMatch(/exit|code \d/i);
  const silent = effectsOf(buildRows(input([say("user", "go"), tool("false", "failed"), say("agent", "no")])))!;
  expect(silent.failures[0]!.result).toBeNull();
});

test("failures come first, then what happened outside the machine, then the edits", () => {
  const items = [say("user", "go"), edit("a.ts", 1, 1), push(), tool("make", "failed"), say("agent", "mixed")];
  const row = buildRows(input(items)).find((r) => r.kind === "effects");
  expect(row && row.kind === "effects" && Object.keys(row.effects)).toEqual(["failures", "external", "edited"]);
});

test("a turn that only read and edited locally has an edit line and no more; a turn that read has none", () => {
  const edits = effectsOf(buildRows(input([say("user", "go"), edit("a.ts", 3, 1), say("agent", "ok")])))!;
  expect(edits.edited).toEqual({ files: 1, added: 3, removed: 1 });
  expect(edits.external).toEqual([]);
  expect(effectsOf(buildRows(input([say("user", "go"), tool("ls"), say("agent", "ok")])))).toBeNull();
});

test("the turn that is still running has no effects row yet; a replayed turn shows no time anywhere", () => {
  const items = [say("user", "go"), edit("a.ts", 1, 0), say("agent", "partial")];
  expect(effectsOf(buildRows(input(items, { running: true })))).toBeNull();
  const timed = items.map((item, k) => ({ ...item, startedMs: 1000 * (k + 1), endedMs: 1000 * (k + 3) }));
  const sigs = (rows: Row[]) => rows.map((r) => `${r.kind}:${r.sig.replace(/^\d+\|/, "")}`);
  expect(sigs(buildRows(input(timed)))).toEqual(sigs(buildRows(input(items))));
});

test("each turn gets its own effects row, before the next question", () => {
  const items = [
    say("user", "one"),
    push(),
    say("agent", "a"),
    say("user", "two"),
    edit("b.ts", 1, 0),
    say("agent", "b"),
  ];
  expect(kinds(buildRows(input(items)))).toEqual([
    "user",
    "work",
    "agent",
    "effects",
    "user",
    "work",
    "agent",
    "effects",
  ]);
});

test("streaming rebuilds the last unit only: the part before it is read once and its effects ride along", () => {
  const head = [say("user", "one"), push(), say("agent", "a"), say("user", "two"), edit("b.ts", 2, 1), tool("ls")];
  const grow = (tail: SessionItem[]) => [...head, ...tail];
  const full = (items: SessionItem[]) => buildRows(input(items));

  const items = grow([tool("make", "failed"), say("agent", "done")]);
  const at = unitStart(items, items.length - 1);
  const carry: TurnCarry = { groups: [] };
  const built = buildRows(input(items), undefined, { from: 0, to: at, carry });
  // The tail reads its own part and the carry, never the committed items again.
  let reads = 0;
  const watched = new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key) && Number(key) < at - 1) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const tail = buildRows(input(watched), undefined, {
    from: at,
    to: items.length,
    carry: { groups: [...carry.groups] },
  });
  expect(reads).toBe(0);
  expect(built.concat(tail).map((r) => r.sig)).toEqual(full(items).map((r) => r.sig));
  expect(kinds(built.concat(tail))).toEqual(kinds(full(items)));
});

test("an effects row that did not change is the same object when its turn is read again", () => {
  const items = [say("user", "one"), push(), say("agent", "a"), say("user", "two"), say("agent", "partial")];
  const first = buildRows(input(items));
  const grown = [...items.slice(0, 4), { ...items[4]!, rev: 2, text: "partial text" }];
  const second = buildRows(input(grown), new Map(first.map((r) => [r.key, r])));
  expect(second.find((r) => r.kind === "effects")).toBe(first.find((r) => r.kind === "effects"));
});
