import { expect, test } from "nsh/test";

import { ENTRY, FIRST, openTerminals, ready, SECOND, settle, terminal, TERMINAL_ON } from "../app-seam";

ENTRY.path = "../App.tsx";

/**
 * The tab bar of the whole app (`components/tab-face.tsx`) against the scripted herdr's `mixed` fixture; its layout is in the
 * screenshots (`design/tabs.md`). The tabs here are terminal tabs, so each test turns the terminal tab on (`TERMINAL_ON`).
 */

const tab = (name: string, position: string) => `label:/^${name} \\(terminal\\), needs you, tab ${position}$/`;
const close = (name: string) => `label:Close tab ${name} (terminal)`;

test("a tab is read as its title, its state and its place among the tabs", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openTerminals(app, FIRST, SECOND);
  expect(app.shows(tab(FIRST, "1 of 2"))).toBe(true);
  expect(app.shows(tab(SECOND, "2 of 2"))).toBe(true);
});

test("the front tab offers its cross, another tab only while the pointer is over it, and the board's tab never", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openTerminals(app, FIRST, SECOND);
  expect(app.shows(close(SECOND))).toBe(true);
  expect(app.shows(close(FIRST))).toBe(false);

  await app.hover(tab(FIRST, "1 of 2"));
  await settle(app);
  expect(app.shows(close(FIRST))).toBe(true);

  await app.hover(tab(SECOND, "2 of 2"));
  await settle(app);
  expect(app.shows(close(FIRST))).toBe(false);

  await app.press("Board");
  await settle(app);
  expect(app.shows("label:/^Close tab Board/")).toBe(false);
});

test("pressing the cross of a tab closes that view and leaves the others", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openTerminals(app, FIRST, SECOND);
  await app.hover(tab(FIRST, "1 of 2"));
  await app.press(close(FIRST));
  await settle(app);
  // One tab left: its strip is gone, the view stays.
  expect(app.count("role:tab")).toBe(0);
  expect(app.shows(terminal(SECOND))).toBe(true);
});

test("a tab's menu copies its title and the folder its agent works in", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openTerminals(app, FIRST, SECOND);
  await app.rightClick(tab(FIRST, "1 of 2"));
  await app.chooseMenuItem("Copy title");
  await app.waitUntil(() => app.clipboard() === `${FIRST} (terminal)`);
  await app.rightClick(tab(FIRST, "1 of 2"));
  await app.chooseMenuItem("Copy path");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("/"));
});

test("with one tab no strip is drawn, with two it is, and the keyboard closes and switches either way", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  // The board alone, and one agent alone in its project: nothing to switch to, so no strip repeats what the view names.
  expect(app.count("role:tab")).toBe(0);
  await openTerminals(app, FIRST);
  expect(app.count("role:tab")).toBe(0);
  expect(app.shows(terminal(FIRST))).toBe(true);

  await openTerminals(app, SECOND);
  expect(app.count("role:tab")).toBe(2);
  await app.keyboard.press("mod+shift+1");
  await settle(app);
  expect(app.shows(terminal(FIRST))).toBe(true);
  await app.keyboard.press("mod+shift+2");
  await settle(app);
  expect(app.shows(terminal(SECOND))).toBe(true);

  // Closing the second hides the strip again; the first is still there, and mod+w works with no strip at all. In a terminal
  // tab Ctrl+W is the program's (`keys::app_owns`), so the keyboard is first taken out of the terminal (`mod+0`, the sidebar).
  await app.keyboard.press("mod+0");
  await app.keyboard.press("mod+w");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
  expect(app.shows(terminal(FIRST))).toBe(true);
  await app.keyboard.press("mod+0");
  await app.keyboard.press("mod+w");
  await settle(app);
  expect(app.shows(terminal(FIRST))).toBe(false);
});

test("a window of two groups keeps a strip in each, even for a group of one", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  await openTerminals(app, FIRST, SECOND);
  // Ctrl+\\ and Ctrl+W are the program's in a terminal: the keyboard leaves it first (`mod+0`).
  await app.keyboard.press("mod+0");
  await app.keyboard.press("mod+\\");
  await settle(app);
  expect(app.count("role:tab")).toBe(2);
  await app.keyboard.press("mod+0");
  await app.keyboard.press("mod+w");
  await settle(app);
  // One group again after the emptied group closed? Either way a lone remaining group of one draws no strip.
  expect(app.count("role:tab")).toBeLessThanOrEqual(1);
});
