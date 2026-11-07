import { expect, test } from "nsh/test";
import { fold } from "./text";

test("a search ignores case, diacritics and invisible characters", () => {
  expect(fold("Crème Brûlée")).toBe("creme brulee");
  expect(fold("\u0110")).toBe("d");
  expect(fold("work\u200bspace")).toBe("workspace");
});
