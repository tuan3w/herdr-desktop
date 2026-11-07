import { expect, test } from "nsh/test";

import { largeTargets } from "#lib/settings";

import { spoken } from "./check";
import { inputHeight } from "./fields";

test("a text input is as tall as the other controls under Large hit targets", () => {
  const before = largeTargets();
  largeTargets.set(false);
  expect(inputHeight()).toBe("h-8");
  largeTargets.set(true);
  expect(inputHeight()).toBe("h-11");
  largeTargets.set(before);
});

test("a required or read-only field says so, then what its field says", () => {
  expect(spoken({ required: true }, undefined)).toBe("required");
  expect(spoken({ required: true, readOnly: true }, "Enter a value.")).toBe("required, read only. Enter a value.");
  expect(spoken({}, undefined)).toBe(undefined);
});
