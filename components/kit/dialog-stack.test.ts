import { expect, test } from "nsh/test";
import { pushDialog, removeDialog } from "./dialog-stack";

test("a dialog that opens goes on top, and one that opens twice is still counted once", () => {
  const stack = pushDialog(pushDialog([], "a"), "b");
  expect(stack).toEqual(["a", "b"]);
  expect(pushDialog(stack, "a")).toEqual(["b", "a"]);
});

test("closing a dialog under another leaves the order of the rest, and a closed one that goes away changes nothing", () => {
  const stack = ["a", "b", "c"];
  expect(removeDialog(stack, "b")).toEqual(["a", "c"]);
  expect(removeDialog(stack, "z")).toBe(stack);
});

test("when the nested dialog goes away while open, the one under it is on top again", () => {
  let stack: readonly string[] = [];
  for (const id of ["parent", "child"]) stack = pushDialog(stack, id);
  expect(stack.length).toBe(2);
  expect(stack.at(-1)).toBe("child");
  stack = removeDialog(stack, "child");
  expect(stack.length).toBe(1);
  expect(stack.at(-1)).toBe("parent");
  // the same call for a dialog that was never open (a closed one unmounting) keeps the count
  expect(removeDialog(stack, "child").length).toBe(1);
});
