import { expect, test } from "nsh/test";

import type { SessionItem, ToolItem } from "herdr-desktop/native";

import {
  clockText,
  composerOff,
  durationText,
  itemLabel,
  oneLine,
  outputFromEnd,
  outputView,
  pastTense,
  savedAtText,
  shellLine,
  stepWords,
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

test("an output is all of what the agent kept: a command's is read from its end, a read's from its top", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const run = tool({ toolKind: "execute", head: lines.slice(0, 10), tail: lines.slice(10), omitted: 0 });
  expect(outputView(run).lines).toEqual(lines);
  expect(outputFromEnd(run)).toBe(true);
  expect(outputFromEnd(tool({ toolKind: "read", head: lines }))).toBe(false);
  expect(outputView(tool({ head: ["a"], tail: ["z"], omitted: 4 }))).toEqual({ lines: ["a", "z"], omitted: 4 });
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
  expect(workLine({ ...none, commands: 4, retried: 2 })).toBe("Ran 4 commands · 2 retried");
  expect(workLine({ ...none, commands: 4, retried: 0 })).toBe("Ran 4 commands");
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

test("the saved-copy line names the time of day the copy was written, two digits each", () => {
  expect(savedAtText(new Date(2026, 10, 9, 7, 5).getTime())).toBe("07:05");
  expect(savedAtText(new Date(2026, 10, 9, 23, 59, 59).getTime())).toBe("23:59");
});

test("a command to paste into a terminal never lets an argument become a second command", () => {
  expect(shellLine(["--terminal-login"])).toBe("--terminal-login");
  expect(shellLine(["login", "--provider", "my cloud"])).toBe("login --provider 'my cloud'");
  expect(shellLine(["; rm -rf ~", "$(id)", "`id`", "it's", ""])).toBe(`'; rm -rf ~' '$(id)' '\`id\`' 'it'\\''s' ''`);
  // What is copied is what is read: a hidden direction override is shown, not passed on.
  expect(shellLine(["a\u202eb"])).toContain("‹U+202E›");
});

test("an intent is put in the past once its step is over: only a listed gerund, only its first word", () => {
  expect(pastTense("Checking the sidebar tests")).toBe("Checked the sidebar tests");
  expect(pastTense("running make test")).toBe("Ran make test");
  expect(pastTense("Finding every StatusGlyph use")).toBe("Found every StatusGlyph use");
  // An imperative, or a verb nobody listed, is left as written.
  expect(pastTense("List the files")).toBe("List the files");
  expect(pastTense("Triaging flakes")).toBe("Triaging flakes");
  expect(pastTense("")).toBe("");
});

test("a step is called what the agent said it was for, else what the call is", () => {
  const said = tool({ toolKind: "execute", subject: "python3 - <<'E'\nx\nE", intent: "Checking the menus" });
  expect(stepWords({ ...said, status: "completed" })).toEqual({ words: "Checked the menus", own: true });
  expect(stepWords({ ...said, status: "failed" }).words).toBe("Checked the menus");
  // While it runs the agent's own present tense is right.
  expect(stepWords({ ...said, status: "inProgress" }).words).toBe("Checking the menus");
  // No intent: the line a row says today, never the agent's raw heredoc.
  const bare = tool({ toolKind: "execute", subject: "make test" });
  expect(stepWords(bare)).toEqual({ words: "Ran make test", own: false });
  expect(stepWords(tool({ toolKind: "execute", subject: "make test", intent: "   " })).own).toBe(false);
});

test("the live line is the agent's own words for the call it runs, in the tense it wrote them", () => {
  const running = tool({
    toolKind: "execute",
    subject: "make test",
    status: "inProgress",
    intent: "Running the whole suite",
  });
  expect(liveLine([running])).toBe("Running the whole suite");
  expect(liveLine([{ ...running, intent: undefined }])).toBe("Running make test");
});
