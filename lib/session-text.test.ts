import { expect, test } from "nsh/test";

import type { SessionItem, ToolItem } from "herdr-desktop/native";

import {
  clockText,
  composerOff,
  durationText,
  itemLabel,
  oneLine,
  outputView,
  shellLine,
  tailText,
  toolLine,
  visibleText,
  liveCount,
  liveLine,
  workLine,
} from "#lib/session-text";

const tool = (over: Partial<ToolItem>): ToolItem => ({
  id: "t",
  title: "Tool",
  status: "completed",
  head: [],
  tail: [],
  omitted: 0,
  diffs: [],
  locations: [],
  parts: [],
  terminal: false,
  ...over,
});

test("a tool call is one line a person reads: verb, then what it acted on", () => {
  expect(toolLine(tool({ toolKind: "execute", subject: "cargo test", status: "inProgress" }))).toMatchObject({
    verb: "Running",
    object: "cargo test",
  });
  expect(toolLine(tool({ toolKind: "execute", subject: "cargo test" }))).toMatchObject({ verb: "Ran" });
  expect(toolLine(tool({ toolKind: "read", subject: "/work/app/src/main.rs" }), "/work/app")).toMatchObject({
    verb: "Read",
    object: "src/main.rs",
  });
  const edit = tool({
    toolKind: "edit",
    diffs: [{ path: "/work/app/CHANGELOG.md", new: "a\nb", added: 6, removed: 1 }],
  });
  expect(toolLine(edit, "/work/app")).toMatchObject({ verb: "Created", object: "CHANGELOG.md", added: 6, removed: 1 });
});

test("without a subject the agent's own title is the line, and a kind nobody knows is just its title", () => {
  expect(toolLine(tool({ title: "Run: ls -la", toolKind: "execute" }))).toMatchObject({
    verb: "",
    object: "Run: ls -la",
  });
  expect(toolLine(tool({ title: "Summon", toolKind: "teleport", subject: "x" }))).toMatchObject({
    verb: "",
    object: "Summon",
  });
});

test("what an agent sends cannot hide in the text: direction overrides and escapes are shown as code points", () => {
  expect(visibleText("rm \u202egnp.txt")).toBe("rm ‹U+202E›gnp.txt");
  expect(visibleText("a\u001b[2Jb\tc\nd")).toBe("a‹U+001B›[2Jb\tc\nd");
  expect(toolLine(tool({ toolKind: "execute", subject: "echo \u202etxt" })).object).toContain("‹U+202E›");
});

test("durations read short, and cut text says it was cut", () => {
  expect(durationText(4)).toBe("4s");
  expect(durationText(72)).toBe("1m 12s");
  expect(durationText(7380)).toBe("2h 3m");
  expect(oneLine("one\n two   three", 40)).toBe("one two three");
  expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  expect(tailText("alpha beta gamma delta", 12)).toBe("gamma delta");
});

test("a screen reader hears who spoke and what the row is", () => {
  const user: SessionItem = { id: 1, rev: 1, kind: "message", role: "user", text: "hello", images: [], parts: [] };
  const agent: SessionItem = {
    id: 2,
    rev: 1,
    kind: "message",
    role: "agent",
    text: "x".repeat(300),
    images: [],
    parts: [],
  };
  const call: SessionItem = {
    id: 3,
    rev: 1,
    kind: "tool",
    images: [],
    parts: [],
    tool: tool({ toolKind: "execute", subject: "ls", status: "failed" }),
  };
  expect(itemLabel(user)).toBe("You: hello");
  expect(itemLabel(agent)).toHaveLength("Agent: ".length + 200);
  expect(itemLabel(call)).toBe("Tool: Ran ls, failed");
});

test("the composer says why it is off", () => {
  expect(composerOff({ phase: "idle", connectionLost: false })).toBeNull();
  expect(composerOff({ phase: "connecting", connectionLost: false })).toMatch(/Opening/);
  expect(composerOff({ phase: "ended", connectionLost: false, endedReason: "exited with code 3" })).toBe(
    "Session ended: exited with code 3",
  );
  expect(composerOff({ phase: "working", connectionLost: true })).toMatch(/Reconnect/);
  expect(composerOff({ phase: "authRequired", connectionLost: false })).toMatch(/Sign in/);
});

test("a command's output shows how it ended, a read's shows what it found, and Show all brings the rest", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const run = tool({ toolKind: "execute", head: lines.slice(0, 10), tail: lines.slice(10), omitted: 0 });
  expect(outputView(run, false).lines[0]).toBe("line 13");
  expect(outputView(run, false).hidden).toBe(12);
  const read = tool({ toolKind: "read", head: lines });
  expect(outputView(read, false).lines[0]).toBe("line 1");
  expect(outputView(read, true)).toMatchObject({ hidden: 0 });
  expect(outputView(read, true).lines).toHaveLength(20);
  expect(outputView(tool({ head: ["a"], tail: ["z"], omitted: 4 }), false)).toMatchObject({
    lines: ["a", "z"],
    omitted: 4,
  });
});

test("a folded group is one sentence of counts: zero counts and times are left out, singular is singular", () => {
  const none = { steps: 1, reads: 0, searches: 0, fetches: 0, commands: 0, changed: 0 };
  expect(workLine({ ...none, steps: 15, reads: 8, commands: 4, changed: 3 })).toBe(
    "Read 8 files, ran 4 commands, edited 3 files",
  );
  expect(workLine({ ...none, reads: 1, searches: 1, commands: 1, changed: 1 })).toBe(
    "Read 1 file, ran 1 search, ran 1 command, edited 1 file",
  );
  expect(workLine({ ...none, commands: 2 })).toBe("Ran 2 commands");
  expect(workLine({ ...none, steps: 2 })).toBe("Took 2 steps");
});

test("the live line says what the open call does, and Thinking when none is open", () => {
  const run = tool({ toolKind: "execute", subject: "pnpm test", status: "inProgress" });
  const read = (n: number) => tool({ toolKind: "read", subject: `/w/a${n}.ts`, status: "inProgress" });
  expect(liveLine([run])).toBe("Running pnpm test");
  expect(liveLine([tool({ toolKind: "edit", subject: "/w/lib/ask.ts", status: "inProgress" })], "/w")).toBe(
    "Editing lib/ask.ts",
  );
  expect(liveLine([read(1), read(2), read(3)])).toBe("Reading 3 files");
  expect(liveLine([read(1), run])).toBe("Running pnpm test");
  expect(liveLine([])).toBe("Thinking");
  // The clock counts what the line names: every read of `Reading 3 files`, else only the newest call.
  expect(liveCount([read(1), read(2), read(3)])).toBe(3);
  expect(liveCount([read(1), run])).toBe(1);
  expect(liveCount([])).toBe(0);
});

test("the live line's clock ticks by the second and keeps its width past a minute", () => {
  expect(clockText(0)).toBe("0s");
  expect(clockText(12.9)).toBe("12s");
  expect(clockText(64)).toBe("1m 04s");
  expect(clockText(600)).toBe("10m 00s");
  expect(clockText(3725)).toBe("1h 02m");
});

test("a command to paste into a terminal never lets an argument become a second command", () => {
  expect(shellLine(["--terminal-login"])).toBe("--terminal-login");
  expect(shellLine(["login", "--provider", "my cloud"])).toBe("login --provider 'my cloud'");
  expect(shellLine(["; rm -rf ~", "$(id)", "`id`", "it's", ""])).toBe(`'; rm -rf ~' '$(id)' '\`id\`' 'it'\\''s' ''`);
  // What is copied is what is read: a hidden direction override is shown, not passed on.
  expect(shellLine(["a\u202eb"])).toContain("‹U+202E›");
});
