import { expect, test } from "nsh/test";

import { ENTRY, FIRST, openTerminals, ready, SECOND, settle } from "../app-seam";

ENTRY.path = "../App.tsx";

/** The tab bar of the whole app (`components/tab-face.tsx`) against the scripted herdr's `mixed` fixture; its layout is in the screenshots (`design/tabs.md`). */

const tab = (name: string, position: string) => `label:/^${name} \\(view\\), needs you, tab ${position}$/`;
const close = (name: string) => `label:Close tab ${name} (view)`;

test("a tab is read as its title, its state and its place among the tabs", async () => {
  const app = await ready();
  await openTerminals(app, FIRST, SECOND);
  expect(app.shows(tab(FIRST, "1 of 2"))).toBe(true);
  expect(app.shows(tab(SECOND, "2 of 2"))).toBe(true);
});

test("the front tab offers its cross, another tab only while the pointer is over it, and the board's tab never", async () => {
  const app = await ready();
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
  const app = await ready();
  await openTerminals(app, FIRST, SECOND);
  await app.hover(tab(FIRST, "1 of 2"));
  await app.press(close(FIRST));
  await settle(app);
  expect(app.count("role:tab")).toBe(1);
  expect(app.shows(tab(SECOND, "1 of 1"))).toBe(true);
});

test("a tab's menu copies its title and the folder its agent works in", async () => {
  const app = await ready();
  await openTerminals(app, FIRST);
  await app.rightClick(tab(FIRST, "1 of 1"));
  await app.chooseMenuItem("Copy title");
  await app.waitUntil(() => app.clipboard() === `${FIRST} (view)`);
  await app.rightClick(tab(FIRST, "1 of 1"));
  await app.chooseMenuItem("Copy path");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("/"));
});
