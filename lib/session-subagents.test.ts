import { expect, test } from "nsh/test";

import type { SubagentProgress, ToolItem } from "herdr-desktop/native";

import {
  anyActive,
  linesShown,
  subagentDoing,
  subagentLabel,
  subagentsOf,
  subagentStatusText,
  subagentSummary,
  toolPhrase,
} from "#lib/session-subagents";
import { isSubagent } from "#lib/session-text";

const agent = (over: Partial<SubagentProgress>): SubagentProgress => ({
  id: "audit",
  name: "audit",
  agent: "task",
  status: "running",
  assignment: "",
  toolCount: 0,
  durationMs: 0,
  recentTools: [],
  ...over,
});

const tool = (over: Partial<ToolItem>): ToolItem => ({
  id: "t",
  title: "Spawning audit subagent",
  toolKind: "other",
  status: "inProgress",
  head: [],
  tail: [],
  omitted: 0,
  diffs: [],
  locations: [],
  parts: [],
  terminal: false,
  ...over,
});

test("a call is a subagent card by its kind, or, for omp's launcher (kind other), by carrying subagents", () => {
  expect(isSubagent(tool({ toolKind: "task" }))).toBe(true);
  expect(isSubagent(tool({ progress: [agent({})] }))).toBe(true);
  expect(isSubagent(tool({}))).toBe(false);
  expect(isSubagent(tool({ progress: [] }))).toBe(false);
  expect(isSubagent(tool({ toolKind: "execute", progress: null }))).toBe(false);
  expect(subagentsOf(tool({}))).toEqual([]);
});

test("a subagent line is one sentence for a screen reader: name, state, what it does, tools, time", () => {
  const a = agent({
    name: "audit",
    toolCount: 12,
    durationMs: 64_000,
    currentTool: "read /work/src/auth.ts",
  });
  expect(subagentLabel(a, "/work")).toBe("Subagent audit, running, Reading src/auth.ts, 12 tools, 1m 4s");
  // Finished: the last tool it ran, past tense; no current tool.
  const done = agent({ status: "completed", toolCount: 1, durationMs: 4075, recentTools: ["yield"] });
  expect(subagentLabel(done)).toBe("Subagent audit, done, yield, 1 tool, 4s");
  // Nothing reported yet: only what is known.
  expect(subagentLabel(agent({ status: "pending" }))).toBe("Subagent audit, waiting");
  expect(subagentStatusText("aborted")).toBe("stopped");
});

test("a tool reads as a phrase while it runs and after, and a stale current tool of a finished subagent is not shown", () => {
  expect(toolPhrase("bash pnpm test", true)).toBe("Running pnpm test");
  expect(toolPhrase("bash pnpm test", false)).toBe("Ran pnpm test");
  expect(toolPhrase("custom_tool x", true)).toBe("custom_tool x");
  expect(subagentDoing(agent({ status: "completed", currentTool: "read a.ts", recentTools: ["edit b.ts"] }))).toBe(
    "Edited b.ts",
  );
});

test("lines stay in view while any subagent works, and fold when all are done unless the card is open", () => {
  const working = [agent({}), agent({ id: "b", status: "completed" })];
  const done = [agent({ status: "completed" }), agent({ id: "b", status: "failed" })];
  expect(anyActive(working)).toBe(true);
  expect(anyActive(done)).toBe(false);
  expect(linesShown(working, false)).toBe(2);
  expect(linesShown(done, false)).toBe(0);
  expect(linesShown(done, true)).toBe(2);
  expect(linesShown([], true)).toBe(0);
});

test("the summary of a finished card counts the subagents and the longest time, and says what failed", () => {
  const done = (ms: number, status: SubagentProgress["status"] = "completed", id = "a") =>
    agent({ id, status, durationMs: ms });
  expect(
    subagentSummary([done(61_000, "completed", "a"), done(130_000, "completed", "b"), done(5_000, "completed", "c")]),
  ).toBe("3 subagents, 2m 10s");
  expect(subagentSummary([done(4_000)])).toBe("1 subagent, 4s");
  expect(subagentSummary([done(4_000), done(9_000, "failed", "b"), done(1_000, "aborted", "c")])).toBe(
    "3 subagents, 1 failed, 1 stopped, 9s",
  );
  expect(subagentSummary([done(0)])).toBe("1 subagent");
  // One still works: no summary, the lines say it.
  expect(subagentSummary([done(4_000), agent({ id: "b" })])).toBe("");
  expect(subagentSummary([])).toBe("");
});
