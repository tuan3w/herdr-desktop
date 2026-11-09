import { expect, test } from "nsh/test";

import { isNewer } from "#lib/updates";

test("versions compare by number, not by text, and a tag that is not x.y.z is never newer", () => {
  expect(isNewer("v0.1.10", "0.1.9")).toBe(true);
  expect(isNewer("0.2.0", "0.1.99")).toBe(true);
  expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("0.1.2", "0.1.3")).toBe(false);
  expect(isNewer("v0.2.0-rc1", "0.1.0")).toBe(false);
  expect(isNewer("nightly", "0.1.0")).toBe(false);
});

test("an alpha is offered the next alpha and its stable release; a stable release is never offered an alpha", () => {
  expect(isNewer("v0.1.0", "0.1.0-alpha.1")).toBe(true);
  expect(isNewer("v0.1.1", "0.1.0-alpha.3")).toBe(true);
  expect(isNewer("v0.1.0-alpha.6", "0.1.0-alpha.5")).toBe(true);
  expect(isNewer("v0.1.0-alpha.10", "0.1.0-alpha.9")).toBe(true);
  expect(isNewer("v0.1.0-beta.1", "0.1.0-alpha.9")).toBe(true);
  expect(isNewer("v0.1.0-alpha.5", "0.1.0-alpha.5")).toBe(false);
  expect(isNewer("v0.1.0-alpha.4", "0.1.0-alpha.5")).toBe(false);
  expect(isNewer("v0.0.9", "0.1.0-alpha.1")).toBe(false);
  expect(isNewer("v0.1.1-alpha.1", "0.1.0")).toBe(false);
  expect(isNewer("edge", "0.1.0-alpha.5")).toBe(false);
});
