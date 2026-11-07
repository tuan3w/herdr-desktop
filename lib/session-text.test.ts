import { expect, test } from "nsh/test";
import type { SessionItem, ToolItem } from "herdr-desktop/native";
import { composerOff, durationText, itemLabel, oneLine, outputView, shellLine, tailText, toolLine, visibleText, workHead, workParts } from "#lib/session-text";

const tool = (over: Partial<ToolItem>): ToolItem => ({ id: "t", title: "Tool", status: "completed", head: [], tail: [], omitted: 0, diffs: [], locations: [], parts: [], terminal: false, ...over });

test("a tool call is one line a person reads: verb, then what it acted on", () => {
  expect(toolLine(tool({ toolKind: "execute", subject: "cargo test", status: "inProgress" }))).toMatchObject({ verb: "Running", object: "cargo test" });
  expect(toolLine(tool({ toolKind: "execute", subject: "cargo test" }))).toMatchObject({ verb: "Ran" });
  expect(toolLine(tool({ toolKind: "read", subject: "/work/app/src/main.rs" }), "/work/app")).toMatchObject({ verb: "Read", object: "src/main.rs" });
  const edit = tool({ toolKind: "edit", diffs: [{ path: "/work/app/CHANGELOG.md", new: "a\nb", added: 6, removed: 1 }] });
  expect(toolLine(edit, "/work/app")).toMatchObject({ verb: "Created", object: "CHANGELOG.md", added: 6, removed: 1 });
});

test("without a subject the agent's own title is the line, and a kind nobody knows is just its title", () => {
  expect(toolLine(tool({ title: "Run: ls -la", toolKind: "execute" }))).toMatchObject({ verb: "", object: "Run: ls -la" });
  expect(toolLine(tool({ title: "Summon", toolKind: "teleport", subject: "x" }))).toMatchObject({ verb: "", object: "Summon" });
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
  const agent: SessionItem = { id: 2, rev: 1, kind: "message", role: "agent", text: "x".repeat(300), images: [], parts: [] };
  const call: SessionItem = { id: 3, rev: 1, kind: "tool", images: [], parts: [], tool: tool({ toolKind: "execute", subject: "ls", status: "failed" }) };
  expect(itemLabel(user)).toBe("You: hello");
  expect(itemLabel(agent)).toHaveLength("Agent: ".length + 200);
  expect(itemLabel(call)).toBe("Tool: Ran ls, failed");
});

test("the composer says why it is off", () => {
  expect(composerOff({ phase: "idle", connectionLost: false })).toBeNull();
  expect(composerOff({ phase: "connecting", connectionLost: false })).toMatch(/Opening/);
  expect(composerOff({ phase: "ended", connectionLost: false, endedReason: "exited with code 3" })).toBe("Session ended: exited with code 3");
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
  expect(outputView(tool({ head: ["a"], tail: ["z"], omitted: 4 }), false)).toMatchObject({ lines: ["a", "z"], omitted: 4 });
});

test("a group's header says how long and what it did, and says nothing it does not know", () => {
  expect(workHead({ running: false, seconds: 4 })).toBe("Worked for 4s");
  expect(workHead({ running: true, seconds: 6 })).toBe("Working · 6s");
  expect(workHead({ running: false, seconds: null })).toBe("Worked");
  expect(workParts({ steps: 5, commands: 3, changed: 1, failed: 1 })).toEqual(["3 commands", "1 file changed", "1 failed"]);
  expect(workParts({ steps: 2, commands: 0, changed: 0, failed: 0 })).toEqual(["2 steps"]);
});

test("a command to paste into a terminal never lets an argument become a second command", () => {
  expect(shellLine(["--terminal-login"])).toBe("--terminal-login");
  expect(shellLine(["login", "--provider", "my cloud"])).toBe("login --provider 'my cloud'");
  expect(shellLine(["; rm -rf ~", "$(id)", "`id`", "it's", ""])).toBe(`'; rm -rf ~' '$(id)' '\`id\`' 'it'\\''s' ''`);
  // What is copied is what is read: a hidden direction override is shown, not passed on.
  expect(shellLine(["a\u202eb"])).toContain("‹U+202E›");
});
