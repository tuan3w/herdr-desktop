import { expect, test } from "nsh/test";

import type { BackgroundRow, SubagentRow } from "herdr-desktop/native";

import {
  agoText,
  elapsedText,
  entriesOf,
  finishedLine,
  firstSentence,
  runningLine,
  sectionsOf,
  seedAcknowledged,
} from "#lib/session-inspector";

const sub = (name: string, status: string, over: Partial<SubagentRow> = {}): SubagentRow => ({
  name,
  agent: "general-purpose",
  status,
  assignment: `Do ${name}. Then report.`,
  toolCount: 0,
  recentTools: [],
  ...over,
});
const task = (key: string, over: Partial<BackgroundRow> = {}): BackgroundRow => ({
  key,
  kind: "shell",
  status: "running",
  title: "pnpm test",
  active: true,
  stoppable: false,
  ...over,
});

test("a row says the first sentence of what it was asked, never the whole prompt", () => {
  expect(firstSentence("Audit the auth module. Read every file.\n\nDo not change anything.")).toBe(
    "Audit the auth module.",
  );
  expect(firstSentence("No full stop here")).toBe("No full stop here");
  expect(firstSentence("Check v1.2 of the api first. Then go.")).toBe("Check v1.2 of the api first.");
});

test("a subagent started in the background is one row that takes its task's times and stop", () => {
  const rows = entriesOf({
    subagents: [sub("audit", "running", { task: "0/a1" })],
    background: [task("0/a1", { kind: "agent", title: "audit", startedMs: 1000, stoppable: true }), task("0/b1")],
  });
  expect(rows.map((r) => r.key)).toEqual(["sub:audit", "task:0/b1"]);
  expect(rows[0]!.startedMs).toBe(1000);
  expect(rows[0]!.stop).toBe("0/a1");
});

test("a command reads as the chat's lines do: where it runs is not what it did", () => {
  const [row] = entriesOf({
    subagents: [],
    background: [
      task("0/b1", { title: "cd /home/dev/x && pnpm test --watch", detail: "cd /home/dev/x && pnpm test --watch" }),
    ],
  });
  expect(row!.name).toBe("pnpm test --watch");
});

test("a failure already over when the chat opened is history; one that arrives later needs the person", () => {
  const before = entriesOf({ subagents: [sub("old", "failed"), sub("b", "running")], background: [] });
  const seen = seedAcknowledged(before);
  const after = entriesOf({ subagents: [sub("old", "failed"), sub("b", "failed")], background: [] });
  const s = sectionsOf(after, seen);
  expect(s.needs.map((e) => e.name)).toEqual(["b"]);
  expect(s.finished.map((g) => g.name)).toEqual(["old"]);
});

test("finished rows group by name, newest first, and the fold says the newest end only when the log gives one", () => {
  const rows = entriesOf({
    subagents: [],
    background: [
      task("0/1", { active: false, status: "finished", title: "pnpm build", endedMs: 1000 }),
      task("0/2", { active: false, status: "finished", title: "pnpm build", endedMs: 5000 }),
      task("0/3", { active: false, status: "finished", title: "make", endedMs: 3000 }),
    ],
  });
  const s = sectionsOf(rows, new Set());
  expect(s.finished.map((g) => [g.name, g.entries.length])).toEqual([
    ["pnpm build", 2],
    ["make", 1],
  ]);
  expect(finishedLine(s, 5000 + 35 * 60_000)).toBe("Finished 3 · last 35 min ago");
  const untimed = sectionsOf(entriesOf({ subagents: [sub("a", "completed")], background: [] }), new Set());
  expect(finishedLine(untimed, 0)).toBe("Finished 1");
});

test("times are minutes at most as fine as a minute, and words for the chat's quiet line", () => {
  expect(elapsedText(20_000)).toBe("<1m");
  expect(elapsedText(4 * 60_000)).toBe("4m");
  expect(elapsedText(72 * 60_000)).toBe("1h 12m");
  expect(agoText(30_000)).toBe("just now");
  expect(agoText(3 * 3600_000)).toBe("3 h ago");
  const running = entriesOf({ subagents: [sub("a", "running")], background: [task("0/1"), task("0/2")] });
  expect(runningLine(running)).toBe("1 subagent and 2 background tasks running");
  expect(runningLine([])).toBe("");
});
