import { expect, test } from "nsh/test";
import { rowsOf, visibleText } from "./visible-text";

test("a character that hides what a command says is shown as its code point", () => {
  expect(visibleText("echo ok\u202e; rm -rf ~")).toBe("echo ok‹U+202E›; rm -rf ~");
  expect(visibleText("ls\u200b-la")).toBe("ls‹U+200B›-la");
  expect(visibleText("a\u001b[2Jb")).toBe("a‹U+001B›[2Jb");
});

test("a multi-line script keeps its lines and tabs, and a screenful of blank lines is counted instead of drawn", () => {
  expect(visibleText("if x\n\tthen y\nfi")).toBe("if x\n    then y\nfi");
  expect(visibleText("first\n\n\n\n\nlast")).toBe("first\n↵ 4 blank lines\nlast");
  expect(visibleText("first\n\nlast")).toBe("first\n\nlast");
});

test("rows of a command are counted by wrapping each line", () => {
  expect(rowsOf("one\ntwo", 80)).toBe(2);
  expect(rowsOf("x".repeat(250), 100)).toBe(3);
  expect(rowsOf("", 100)).toBe(1);
});
