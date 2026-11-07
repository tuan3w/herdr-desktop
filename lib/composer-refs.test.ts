import { expect, test } from "nsh/test";

import {
  acceptMention,
  activeRefs,
  emptyHistory,
  fileGlyph,
  insertToken,
  keepAtomic,
  looksBinary,
  markRuns,
  type MentionRef,
  mentionAt,
  nextNumber,
  outgoing,
  type PasteRef,
  type PictureRef,
  plainText,
  refKey,
  recallDown,
  recallUp,
  remember,
  sendable,
  spansOf,
  tokenOf,
  withoutRef,
} from "#lib/composer-refs";

const file = (rel: string, folder = false): MentionRef => ({
  kind: "mention",
  path: `/w/${rel}`,
  rel,
  folder,
});
const picture = (number: number): PictureRef => ({
  kind: "picture",
  id: `p${number}`,
  number,
  path: `/data/composer/${number}.png`,
  name: `Pasted image ${number}.png`,
  mime: "image/png",
  width: 10,
  height: 10,
  bytes: 1200,
  scaled: false,
  thumb: "",
});
const paste = (number: number, text: string): PasteRef => ({
  kind: "paste",
  id: `t${number}`,
  number,
  text,
  lines: text.split("\n").length,
});

test("a mention is a token that stands alone: a longer name, an address and a path beyond it are not it", () => {
  const ref = file("src/a.rs");
  expect(tokenOf(ref)).toBe("@src/a.rs");
  expect(spansOf("look at @src/a.rs now", ref)).toHaveLength(1);
  expect(spansOf("look at @src/a.rs.", ref)).toHaveLength(1);
  expect(spansOf("(see @src/a.rs)", ref)).toHaveLength(1);
  expect(spansOf("@src/a.rsx", ref)).toHaveLength(0);
  expect(spansOf("@src/a.rs.bak", ref)).toHaveLength(0);
  expect(spansOf("me@src/a.rs", ref)).toHaveLength(0);
  expect(tokenOf(file("my notes.md"))).toBe('@"my notes.md"');
  expect(tokenOf(file("src", true))).toBe("@src/");
});

test("a chip lasts as long as its words: delete them and it goes, type them again and it is back", () => {
  const known = [file("a.rs"), paste(1, "a\nb")];
  expect(activeRefs("compare @a.rs with [Pasted text #1 +2 lines]", known)).toHaveLength(2);
  expect(activeRefs("compare with [Pasted text #1 +2 lines]", known)).toEqual([paste(1, "a\nb")]);
  expect(activeRefs("", known)).toEqual([]);
  expect(activeRefs("compare @a.rs again", known)).toEqual([file("a.rs")]);
});

test("a picture has no words: it counts while it is in the box, whatever the text says", () => {
  const known = [picture(1), file("a.rs")];
  expect(tokenOf(picture(1))).toBe("");
  expect(spansOf("anything [Image #1]", picture(1))).toEqual([]);
  expect(activeRefs("", known)).toEqual([picture(1)]);
  expect(activeRefs("see @a.rs", known)).toEqual(known);
  expect(refKey(picture(1))).not.toBe(refKey(picture(2)));
});

test("Backspace on a chip's words takes the whole chip, and an edit that leaves it alone changes nothing", () => {
  const known = [file("src/main.rs")];
  const before = "look at @src/main.rs and more";
  // Backspace right after the `s` of main.rs: one character gone, the rest of the token goes too.
  const cut = before.replace("main.rs", "main.r");
  expect(keepAtomic(before, cut, known)).toEqual({ text: "look at  and more", caret: 8 });
  // Select the whole token and delete: nothing is left to tidy.
  expect(keepAtomic(before, "look at  and more", known)).toBeNull();
  // Typing, or deleting somewhere else, is not touched.
  expect(keepAtomic(before, `${before}!`, known)).toBeNull();
  expect(keepAtomic(before, "look @src/main.rs and more", known)).toBeNull();
  // The end of the token and a space behind it: only the space goes, the chip stays.
  expect(keepAtomic("@a.rs ", "@a.rs", [file("a.rs")])).toBeNull();
});

test("taking a chip off removes its words and the one space after them", () => {
  const ref = file("a.rs");
  expect(withoutRef("fix @a.rs now", ref)).toBe("fix now");
  expect(withoutRef("fix @a.rs", ref)).toBe("fix");
  expect(withoutRef("@a.rs", ref)).toBe("");
});

test("a token is put where the caret is with a space where a word would stick to it", () => {
  expect(insertToken("look", 4, "@a.rs")).toEqual({ text: "look @a.rs ", caret: 11 });
  expect(insertToken("look ", 5, "@a.rs")).toEqual({ text: "look @a.rs ", caret: 11 });
  expect(insertToken("", 0, "@a.rs")).toEqual({ text: "@a.rs ", caret: 6 });
  expect(insertToken("ab cd", 2, "@x")).toEqual({ text: "ab @x cd", caret: 5 });
});

test("an @ starts a mention at a word, after a bracket or a quote, never inside a word", () => {
  expect(mentionAt("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAt("see (@src", 9)).toEqual({ start: 5, query: "src" });
  expect(mentionAt('say "@x', 7)).toEqual({ start: 5, query: "x" });
  expect(mentionAt("mail me@host", 12)).toBeNull();
  expect(mentionAt("@done and more", 14)).toBeNull();
  expect(mentionAt("fix @a and @b", 9)).toBeNull();
  expect(mentionAt("look @src/a.rs", 14)).toEqual({ start: 5, query: "src/a.rs" });
  expect(acceptMention("look @sr and", { start: 5, query: "sr" }, 8, "@src/a.rs")).toEqual({
    text: "look @src/a.rs and",
    caret: 14,
  });
  expect(acceptMention("look @sr", { start: 5, query: "sr" }, 8, "@src/")).toEqual({ text: "look @src/ ", caret: 11 });
});

test("a message goes out with its mentions in the words, its pastes in full and its pictures in order", () => {
  const long = "line one\nline two\nline three";
  const known = [file("src/a.rs"), file("docs", true), picture(2), picture(1), paste(1, long), file("gone.rs")];
  const text = "see @src/a.rs and @docs/ then and [Pasted text #1 +3 lines]  ";
  const sent = outgoing(text, known, ["/w/extra.png", "/w/src/a.rs"]);
  expect(sent.text).toBe(`see @src/a.rs and @docs/ then and ${long}`);
  expect(sent.files).toEqual(["/w/extra.png", "/w/src/a.rs", "/w/docs"]);
  expect(sent.pictures.map((p) => p.number)).toEqual([1, 2]);
  expect(sent.files).not.toContain("/w/gone.rs");
});

test("pictures go out in the order they were taken, whatever the words say or the box holds them in", () => {
  const known = [picture(3), picture(1), picture(2)];
  expect(outgoing("compare these", known, []).pictures.map((p) => p.number)).toEqual([1, 2, 3]);
  expect(outgoing("", known, []).pictures.map((p) => p.path)).toEqual([
    "/data/composer/1.png",
    "/data/composer/2.png",
    "/data/composer/3.png",
  ]);
  expect(outgoing("compare these", known, []).text).toBe("compare these");
});

test("what is sent is kept for Up as words only", () => {
  const known = [picture(1), paste(1, "a\nb")];
  expect(plainText("look at [Pasted text #1 +2 lines]", known)).toBe("look at a\nb");
});

test("there is something to send when there are words, a file or a chip", () => {
  const known = [picture(1)];
  expect(sendable("  ", [], [])).toBe(false);
  expect(sendable("hi", [], [])).toBe(true);
  expect(sendable("", [], ["/w/a"])).toBe(true);
  expect(sendable("", known, [])).toBe(true);
  expect(sendable("", [], [])).toBe(false);
});

test("pictures are numbered one past the highest the box ever used, even after one was taken off", () => {
  expect(nextNumber([], "picture")).toBe(1);
  expect(nextNumber([picture(1), picture(3)], "picture")).toBe(4);
  expect(nextNumber([picture(2)], "paste")).toBe(1);
});

test("the letters a search matched are marked and nothing else", () => {
  const path = "src/auth/login.rs";
  // marks over the whole path: "au" (4,6) and "lo" (9,11)
  expect(markRuns(path, [4, 6, 9, 11], 9)).toEqual([
    { text: "lo", marked: true },
    { text: "gin.rs", marked: false },
  ]);
  expect(markRuns(path, [4, 6, 9, 11], 0, 8)).toEqual([
    { text: "src/", marked: false },
    { text: "au", marked: true },
    { text: "th", marked: false },
  ]);
  expect(markRuns("abc", [])).toEqual([{ text: "abc", marked: false }]);
});

test("Up walks back through what was sent and Down walks forward to what was being typed", () => {
  let h = emptyHistory();
  h = remember(h, "first");
  h = remember(h, "second");
  h = remember(h, "second");
  h = remember(h, "   ");
  expect(h.items).toEqual(["first", "second"]);
  const one = recallUp(h, "draft")!;
  expect(one.text).toBe("second");
  const two = recallUp(one.history, "second")!;
  expect(two.text).toBe("first");
  expect(recallUp(two.history, "first")).toBeNull();
  const back = recallDown(two.history)!;
  expect(back.text).toBe("second");
  const home = recallDown(back.history)!;
  expect(home.text).toBe("draft");
  expect(home.history.at).toBeNull();
  expect(recallDown(home.history)).toBeNull();
  expect(recallUp(emptyHistory(), "")).toBeNull();
});

test("a file's icon is by its kind: folders, pictures, scripts, configuration and code are told apart", () => {
  expect(fileGlyph("src", true)).toBe("folder");
  expect(fileGlyph("shot.PNG", false)).toBe("image");
  expect(fileGlyph("run.sh", false)).toBe("terminal");
  expect(fileGlyph("Cargo.toml", false)).toBe("sliders");
  expect(fileGlyph("README.md", false)).toBe("list");
  expect(fileGlyph("main.rs", false)).toBe("file");
});

test("a picture's bytes that arrive as text are not text, and a log or a cell is", () => {
  expect(looksBinary("\u0089PNG\r\n\u001a\n\u0000\u0000")).toBe(true);
  expect(looksBinary("\u00ff\u00d8\u00ff\u00e0")).toBe(true);
  expect(looksBinary("2026-11-07 12:00 request handled\nnext line\twith a tab")).toBe(false);
  expect(looksBinary("")).toBe(false);
});
