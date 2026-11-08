import { expect, test } from "nsh/test";

import { isCut } from "./cut";

const lines = (...text: string[]) => text.map((t) => ({ text: t }));

test("text that fits is not cut, whatever the tip says", () => {
  expect(isCut(lines("auth.ts"), "auth.ts")).toBe(false);
  expect(isCut(lines("src/"), "src/")).toBe(false);
  expect(isCut([], "")).toBe(false);
});

test("a prefix that was laid out is cut, and grows whole again when the box widens", () => {
  expect(isCut(lines("a-really-long-"), "a-really-long-name.tsx")).toBe(true);
  expect(isCut(lines("a-really-long-name.tsx"), "a-really-long-name.tsx")).toBe(false);
  expect(isCut(lines("p"), "packages/core/")).toBe(true);
});

test("a wrapped text that dropped the space it broke at is whole", () => {
  expect(isCut(lines("two words ", "here"), "two words  here")).toBe(false);
  expect(isCut(lines("two"), "two words here")).toBe(true);
});

test("emoji and CJK count once", () => {
  expect(isCut(lines("日本語のファイル"), "日本語のファイル")).toBe(false);
  expect(isCut(lines("日本語"), "日本語のファイル")).toBe(true);
  expect(isCut(lines("👩‍💻 ok"), "👩‍💻 ok")).toBe(false);
});
