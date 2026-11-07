import { expect, test } from "nsh/test";
import { lowersGuard } from "#lib/session-options";

test("only a switch that lowers the guard takes two presses", () => {
  expect(lowersGuard("none", "dangerous")).toBe(true);
  expect(lowersGuard("none", "elevated")).toBe(true);
  expect(lowersGuard("elevated", "dangerous")).toBe(true);
  expect(lowersGuard("dangerous", "none")).toBe(false);
  expect(lowersGuard("dangerous", "dangerous")).toBe(false);
  expect(lowersGuard("none", "none")).toBe(false);
});
