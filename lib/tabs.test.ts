import { expect, test } from "nsh/test";

import { namedPlace, tabLabel, terminalTitle } from "#lib/tabs";

test("a tab is spoken as its title, its state and its place, and says no state it does not have", () => {
  expect(tabLabel("auth (terminal)", "needs you", 2, 8)).toBe("auth (terminal), needs you, tab 3 of 8");
  expect(tabLabel("Board", "", 0, 3)).toBe("Board, tab 1 of 3");
});

const pane = { name: "auth", paneLabel: "", tabLabel: "1", tabNamed: false };

test("a terminal is titled by the most specific name the person gave, and herdr's own default never hides the program's name", () => {
  expect(terminalTitle(pane)).toBe("auth");
  expect(terminalTitle({ ...pane, tabLabel: "deploys", tabNamed: true })).toBe("deploys");
  expect(terminalTitle({ ...pane, paneLabel: "release check", tabLabel: "deploys", tabNamed: true })).toBe(
    "release check",
  );
  expect(terminalTitle({ ...pane, paneLabel: "release check" })).toBe("release check");
});

test("only the workspace and tab names the person gave are said as where a pane is", () => {
  const where = { workspaceLabel: "payments", workspaceNamed: false, tabLabel: "1", tabNamed: false };
  expect(namedPlace(where)).toEqual([]);
  expect(namedPlace({ ...where, workspaceNamed: true })).toEqual(["payments"]);
  expect(namedPlace({ ...where, workspaceNamed: true, tabLabel: "deploys", tabNamed: true })).toEqual([
    "payments",
    "deploys",
  ]);
});
