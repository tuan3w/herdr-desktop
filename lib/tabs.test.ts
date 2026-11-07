import { expect, test } from "nsh/test";

import { tabLabel } from "#lib/tabs";

test("a tab is spoken as its title, its state and its place, and says no state it does not have", () => {
  expect(tabLabel("auth (view)", "needs you", 2, 8)).toBe("auth (view), needs you, tab 3 of 8");
  expect(tabLabel("Board", "", 0, 3)).toBe("Board, tab 1 of 3");
});
