import { expect, test } from "nsh/test";

import { emptyMemory, hintFor, matchCommands, type SlashCommand } from "#lib/slash";
import { withBuiltIns } from "#lib/slash-builtins";

/** The agent's commands go through `withBuiltIns` as `lib/composer.ts` sends them; the list is `matchCommands`'s. */
const names = (list: SlashCommand[]) => list.map((c) => c.name);
const skill = (name: string, description = ""): SlashCommand => ({
  name,
  description,
  source: "builtIn",
  trigger: "/",
  kind: "skill",
});

test("a Claude Code chat read from a terminal lists /clear, /compact and the rest though its log lists nothing", () => {
  const commands = withBuiltIns([], "claude", true);
  const listed = names(matchCommands("/", "claude", commands, emptyMemory()));
  for (const n of ["clear", "compact", "context", "model"]) expect(listed).toContain(n);
  expect(commands.every((c) => c.kind === "command")).toBe(true);
  expect(names(matchCommands("/cl", "claude", commands, emptyMemory()))[0]).toBe("clear");
  expect(hintFor("/model ", commands)).toBe("<model>");
});

test("a command that only opens a dialog in the terminal is not offered", () => {
  expect(names(withBuiltIns([], "claude", true))).not.toContain("config");
  // omp's `/model` opens its picker whatever follows it.
  expect(names(withBuiltIns([], "omp", true))).not.toContain("model");
});

test("the agent's own entry wins on the same name, and its skills come before the built-ins", () => {
  const own = [skill("review-pr", "Reviews a pull request"), skill("compact", "Compact, the project's way")];
  const commands = withBuiltIns(own, "claude", true);
  expect(commands.filter((c) => c.name === "compact")).toEqual([own[1]]);
  expect(names(commands).slice(0, 2)).toEqual(["review-pr", "compact"]);
});

test("a keeper's session and an agent with no table get only what the agent listed", () => {
  const own = [skill("review-pr")];
  expect(withBuiltIns(own, "claude", false)).toEqual(own);
  expect(withBuiltIns(own, "gemini", true)).toEqual(own);
});

test("a whole built-in name typed still leads a longer skill that starts the same way", () => {
  const commands = withBuiltIns([skill("clear-cache")], "claude", true);
  expect(names(matchCommands("/clear", "claude", commands, emptyMemory()))).toEqual(["clear", "clear-cache"]);
});

test("an omp skill is found by its bare name and picked in the form omp runs", () => {
  const commands = withBuiltIns([skill("skill:herdr-design", "Design the window")], "omp", true);
  expect(names(matchCommands("/herdr-design", "omp", commands, emptyMemory()))).toEqual(["skill:herdr-design"]);
  expect(names(matchCommands("/herdr", "omp", commands, emptyMemory()))[0]).toBe("skill:herdr-design");
});
