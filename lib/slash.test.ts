import { expect, test } from "nsh/test";

import {
  BUILT_IN,
  commandsOf,
  emptyMemory,
  hintFor,
  matchCommands,
  parseMemory,
  pinnedOf,
  recordUse,
  sentKey,
  type SlashCommand,
  type SlashMemory,
  togglePin,
  unknownCommand,
  usedOf,
  countOf,
} from "#lib/slash";

/** What the composer's command list does, ported from herdr-mobile's `slash_catalog_test`, `slash_usage_test` and `command_guard_test`. */
const claude = commandsOf("claude");
const names = (list: SlashCommand[]) => list.map((c) => c.name);

/** A clock that moves one minute every time it is read, so every command has its own last-used time. */
function clock() {
  let t = Date.UTC(2026, 0, 1);
  return () => (t += 60_000);
}

function used(agent: string, keys: string[], now = clock(), from: SlashMemory = emptyMemory()): SlashMemory {
  return keys.reduce((m, key) => recordUse(m, agent, key, now()), from);
}

test("a bare slash lists the pinned commands, then the five latest, then the rest in the table's order", () => {
  let memory = used("claude", ["clear", "compact", "model", "resume", "rewind", "context", "cost"]);
  memory = togglePin(togglePin(memory, "claude", "help"), "claude", "exit");
  const all = names(matchCommands("/", "claude", claude, memory));
  expect(all.slice(0, 2)).toEqual(["help", "exit"]);
  expect(all.slice(2, 7)).toEqual(["cost", "context", "rewind", "resume", "model"]);
  expect(all.slice(7, 9)).toEqual(["clear", "compact"]);
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBe(BUILT_IN.claude.length);
});

test("a pinned command is not repeated among the recent ones", () => {
  const memory = togglePin(used("claude", ["cost", "status"]), "claude", "status");
  expect(names(matchCommands("/", "claude", claude, memory)).slice(0, 3)).toEqual(["status", "cost", "clear"]);
});

test("with nothing used a bare slash is the table as it is", () => {
  expect(names(matchCommands("/", "claude", claude, emptyMemory()))).toEqual(BUILT_IN.claude.map((c) => c.name));
});

test("names that start with the word come first, then names that hold it, then descriptions; use breaks ties inside a group", () => {
  const memory = used("claude", ["cost", "cost", "cost", "config"]);
  expect(names(matchCommands("/c", "claude", claude, memory)).slice(0, 5)).toEqual([
    "cost",
    "config",
    "clear",
    "compact",
    "context",
  ]);
  // "files" is only in a description.
  const project: SlashCommand = { name: "compare", description: "Compare two files", source: "project", trigger: "/" };
  expect(names(matchCommands("/files", "claude", [project, ...claude], emptyMemory()))[0]).toBe("compare");
});

test("a project command comes before a built-in one in its group, however much the built-in was used", () => {
  const project: SlashCommand = { name: "cleanup", description: "Tidy", source: "project", trigger: "/" };
  const memory = used("claude", Array(10).fill("clear"));
  expect(names(matchCommands("/cl", "claude", [project, ...claude], memory)).slice(0, 2)).toEqual(["cleanup", "clear"]);
});

test("only a lone /word is completed, and a command typed in full leaves nothing to choose", () => {
  const memory = emptyMemory();
  for (const input of ["hello /co", "/compact now", "/compact ", ""])
    expect(matchCommands(input, "claude", claude, memory)).toEqual([]);
  expect(matchCommands("/", "claude", claude, memory).length).toBeGreaterThan(0);
  expect(matchCommands("/compact", "claude", claude, memory)).toEqual([]);
  expect(names(matchCommands("/compac", "claude", claude, memory))).toContain("compact");
});

test("a pane without an agent has no list", () => {
  expect(matchCommands("/co", "", claude, emptyMemory())).toEqual([]);
});

test("an agent without a table lists only what was pinned or sent", () => {
  const none = commandsOf("omp");
  expect(none).toEqual([]);
  expect(matchCommands("/", "omp", none, emptyMemory())).toEqual([]);
  let memory = used("omp", ["review", "review", "ship"]);
  memory = togglePin(memory, "omp", "deploy");
  expect(names(matchCommands("/", "omp", none, memory))).toEqual(["deploy", "ship", "review"]);
  expect(names(matchCommands("/re", "omp", none, memory))).toEqual(["review"]);
  expect(matchCommands("/zzz", "omp", none, memory)).toEqual([]);
  expect(matchCommands("/ship", "omp", none, memory)).toEqual([]);
});

test("a name pinned or sent that the table lacks still completes, with no description", () => {
  const memory = togglePin(used("claude", ["mine"]), "claude", "ghost");
  expect(names(matchCommands("/", "claude", claude, memory)).slice(0, 2)).toEqual(["ghost", "mine"]);
  expect(matchCommands("/gh", "claude", claude, memory)).toEqual([
    { name: "ghost", description: "", source: "builtIn", trigger: "/" },
  ]);
  expect(names(matchCommands("/min", "claude", claude, memory))).toEqual(["mine"]);
});

test("pins and use belong to the agent, whatever the case of its label", () => {
  const memory = togglePin(used("Claude", ["cost"]), "claude", "cost");
  expect(pinnedOf(memory, "CLAUDE")).toEqual(["cost"]);
  expect(countOf(memory, "claude", "cost")).toBe(1);
  expect(names(matchCommands("/", "codex", commandsOf("codex"), memory))[0]).toBe("new");
});

test("pinning toggles, keeps the order pinned in, and forgets an agent left with none", () => {
  let memory = emptyMemory();
  for (const key of ["a", "b", "c"]) memory = togglePin(memory, "claude", key);
  expect(pinnedOf(memory, "claude")).toEqual(["a", "b", "c"]);
  memory = togglePin(memory, "claude", "b");
  expect(pinnedOf(memory, "claude")).toEqual(["a", "c"]);
  memory = togglePin(togglePin(memory, "claude", "a"), "claude", "c");
  expect(memory.pinned).toEqual({});
});

test("an empty agent or name changes nothing", () => {
  const memory = emptyMemory();
  expect(recordUse(memory, "", "x", 1)).toBe(memory);
  expect(recordUse(memory, "claude", "", 1)).toBe(memory);
  expect(togglePin(memory, " ", "x")).toBe(memory);
});

test("at most 40 are remembered per agent: the busiest, and always the newest", () => {
  const now = clock();
  let memory = emptyMemory();
  for (let i = 0; i < 40; i++) for (let n = 0; n <= i % 5; n++) memory = recordUse(memory, "claude", `old${i}`, now());
  memory = recordUse(memory, "claude", "fresh", now());
  const kept = usedOf(memory, "claude");
  expect(kept.length).toBe(40);
  expect(kept[0]).toBe("fresh");
  // A command sent once is the first to go; the busiest stay.
  expect(kept).not.toContain("old0");
  expect(kept).toContain("old4");
});

test("a command just sent survives forty older ones that were used more, and the bound is per agent", () => {
  const now = clock();
  let memory = emptyMemory();
  for (let i = 0; i < 40; i++) for (let n = 0; n < 3; n++) memory = recordUse(memory, "claude", `busy${i}`, now());
  memory = recordUse(memory, "claude", "just-sent", now());
  expect(usedOf(memory, "claude")[0]).toBe("just-sent");
  memory = recordUse(memory, "codex", "x", now());
  expect(usedOf(memory, "codex")).toEqual(["x"]);
});

test("what was saved comes back as it was, and what does not fit is dropped", () => {
  const memory = togglePin(used("claude", ["cost", "cost", "status"]), "claude", "help");
  expect(parseMemory(JSON.parse(JSON.stringify(memory)))).toEqual(memory);

  const parsed = parseMemory({
    uses: { claude: { ok: [2, 5], zero: [0, 5], text: ["2", 5], short: [1], fine: [1, 9] }, bad: "x", empty: {} },
    pinned: { claude: ["a", 3, "a", "b"], codex: [], other: "no" },
  });
  expect(parsed.uses).toEqual({ claude: { ok: [2, 5], fine: [1, 9] } });
  expect(parsed.pinned).toEqual({ claude: ["a", "b"] });
  for (const junk of [null, 3, "x", [], undefined]) expect(parseMemory(junk)).toEqual(emptyMemory());
});

test("a /word the agent does not list is named, with or without arguments", () => {
  const listed = [commandOf("review", "<pr number>"), commandOf("compact")];
  expect(unknownCommand("/clera", "omp", listed, emptyMemory())).toBe("clera");
  expect(unknownCommand("/clera now please", "omp", listed, emptyMemory())).toBe("clera");
  expect(unknownCommand("  /revue 12  ", "omp", listed, emptyMemory())).toBe("revue");
});

test("a command the agent lists, in any case, and the ones every terminal takes, are not held", () => {
  const listed = [commandOf("review"), commandOf("compact")];
  expect(unknownCommand("/review 12", "omp", listed, emptyMemory())).toBeNull();
  expect(unknownCommand("/Compact", "omp", listed, emptyMemory())).toBeNull();
  for (const word of ["clear", "new", "help", "exit", "quit"])
    expect(unknownCommand(`/${word}`, "omp", listed, emptyMemory())).toBeNull();
});

test("text, a path and a dollar sentence are not commands", () => {
  const listed = [commandOf("review")];
  for (const line of ["please review it", "/usr/bin/env python", "$PATH is wrong", ""])
    expect(unknownCommand(line, "omp", listed, emptyMemory())).toBeNull();
});

test("nothing is said while nothing can be: no list, no slash command at all, no agent", () => {
  expect(unknownCommand("/clera", "omp", [], emptyMemory())).toBeNull();
  const skillOnly: SlashCommand = { name: "write", description: "", source: "builtIn", trigger: "$" };
  expect(unknownCommand("/clera", "omp", [skillOnly], emptyMemory())).toBeNull();
  expect(unknownCommand("/clera", "", [commandOf("review")], emptyMemory())).toBeNull();
});

test("a word the person sent before, or pinned, is not held", () => {
  const listed = [commandOf("review")];
  const memory = togglePin(used("omp", ["ship"]), "omp", "deploy");
  expect(unknownCommand("/ship it", "omp", listed, memory)).toBeNull();
  expect(unknownCommand("/deploy", "omp", listed, memory)).toBeNull();
  expect(unknownCommand("/other", "omp", listed, memory)).toBe("other");
});

test("a sent line is remembered under its command, and a path, text or a lone slash is not a command", () => {
  const none: SlashCommand[] = [];
  expect(sentKey("/model gpt-5", "omp", none)).toBe("model");
  expect(sentKey("/git:sync now", "omp", none)).toBe("git:sync");
  expect(sentKey("/review\nthe second line", "omp", none)).toBe("review");
  expect(sentKey("/skill.v2 x", "omp", none)).toBe("skill.v2");
  for (const line of [
    "/etc/hosts is odd",
    "/usr/bin/env",
    "hello /model",
    " /model",
    "/",
    "/ model",
    "//comment",
    "/-flag",
    "",
    `/${"x".repeat(80)}`,
  ]) {
    expect(sentKey(line, "omp", none)).toBeNull();
  }
  expect(sentKey("/model", "", none)).toBeNull();
});

test("a skill is remembered with its dollar, and a shell variable is a sentence, not a skill nobody has", () => {
  const skill: SlashCommand = { name: "review", description: "Review", source: "project", trigger: "$" };
  expect(sentKey("$review the diff", "codex", [skill])).toBe("$review");
  expect(sentKey("$PATH is wrong on this box", "codex", [skill])).toBeNull();
  expect(sentKey("$HOME", "codex", [skill])).toBeNull();
  expect(sentKey("$PATH is wrong", "omp", [])).toBeNull();
  // The list for `$` shows the skills, and `/` never does.
  expect(names(matchCommands("$", "codex", [skill, ...commandsOf("codex")], emptyMemory()))).toEqual(["review"]);
});

test("what a picked command takes shows after it until the first character", () => {
  const listed = [
    commandOf("review", "<pr number>"),
    commandOf("compact"),
    { ...commandOf("write", "<topic>"), trigger: "$" as const },
  ];
  expect(hintFor("/review ", listed)).toBe("<pr number>");
  expect(hintFor("$write ", listed)).toBe("<topic>");
  for (const input of ["/review 1", "/review", "/review  ", "/compact ", "/nothing ", "review "])
    expect(hintFor(input, listed)).toBeNull();
});

function commandOf(name: string, hint?: string): SlashCommand {
  return { name, description: "", source: "builtIn", trigger: "/", ...(hint ? { hint } : {}) };
}
