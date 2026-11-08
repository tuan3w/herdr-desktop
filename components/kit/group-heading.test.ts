import { expect, test } from "nsh/test";

import { countText, foldable, groupLabel } from "./group-heading";

test("a heading's count is grouped by thousands and never capped", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [1, "1"],
    [999, "999"],
    [1000, "1,000"],
    [10000, "10,000"],
    [1234567, "1,234,567"],
    [-3, "0"],
    [2.7, "2"],
  ];
  for (const [n, text] of cases) expect(countText(n)).toBe(text);
});

test("the spoken name says the title and the count with the right noun", () => {
  expect(groupLabel("src", 1, ["file", "files"])).toBe("src, 1 file");
  expect(groupLabel("src", 0, ["file", "files"])).toBe("src, 0 files");
  expect(groupLabel("components", 10000, ["file", "files"])).toBe("components, 10,000 files");
});

test("a heading folds only when it holds rows and something folds it", () => {
  const toggle = () => {};
  expect(foldable(3, toggle)).toBe(true);
  expect(foldable(0, toggle)).toBe(false);
  expect(foldable(3, undefined)).toBe(false);
});
