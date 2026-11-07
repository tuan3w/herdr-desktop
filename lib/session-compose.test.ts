import { expect, test } from "nsh/test";
import type { EntryView } from "herdr-desktop/native";
import { applyMention, deliveryNote, mentionAt, rankEntries, restoreText, splitQuery } from "./session-compose";

const entry = (name: string, kind: EntryView["kind"] = "file"): EntryView => ({ name, kind, size: 0, readable: true, link: false });

test("an @ starts a mention only at the start of a word, so an address stays typeable", () => {
  expect(mentionAt("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAt("mail me@host", 12)).toBeNull();
  expect(mentionAt("@done and more", 14)).toBeNull();
  expect(mentionAt("fix @a and @b", 9)).toBeNull();
});

test("a mention is picked from the folder it names, the best match first", () => {
  expect(splitQuery("src/ma")).toEqual({ dir: "src/", name: "ma" });
  const list = [entry("README.md"), entry("src", "dir"), entry("main.rs"), entry(".git", "dir"), entry("Cargo.toml")];
  expect(rankEntries(list, "").map((e) => e.name)).toEqual(["src", "README.md", "main.rs", "Cargo.toml"]);
  expect(rankEntries([...list, entry("grammar.txt")], "ma").map((e) => e.name)).toEqual(["main.rs", "grammar.txt"]);
  expect(rankEntries(list, ".g").map((e) => e.name)).toEqual([".git"]);
});

test("picking a file ends the mention; picking a folder goes into it", () => {
  const file = applyMention("see @ma now", { start: 4, query: "ma" }, 7, "src/main.rs", false);
  expect(file).toEqual({ text: "see @src/main.rs now", caret: 16 });
  expect(applyMention("see @sr", { start: 4, query: "sr" }, 7, "src", true)).toEqual({ text: "see @src/", caret: 9 });
});

test("the box says what a send will do, and a message taken back loses nothing typed", () => {
  expect(deliveryNote({ running: true, queue: [] })).toMatch(/queue/);
  expect(deliveryNote({ running: false, queue: [] })).toBeNull();
  expect(restoreText("", "first")).toBe("first");
  expect(restoreText("draft", "first")).toBe("first\ndraft");
});
