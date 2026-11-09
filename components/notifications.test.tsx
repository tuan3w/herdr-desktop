import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { TestNotification } from "herdr-desktop/native";
import type { App } from "nsh/test";

import { ENTRY, FIRST, onBoard, openAgents, ready, settle, shown, TERMINAL_ON } from "../app-seam";
import mixed from "../fixtures/herdr/mixed.json";
import { scripted, sentKeys } from "./board-seam";

ENTRY.path = "../App.tsx";

/** Desktop notifications through the whole app, against the scripted herdr: it records what the app would have shown. */
const asking = (command: string) =>
  (mixed.panes as Record<string, { screen: string[] }>)["w1:p1"].screen.map((r) =>
    r.replace(/touch \/tmp\/hm-capture-claude\/[^\s\u001b]+/, command),
  );

/** The app with notifications on and its window away, with what was blocked at that moment taken as seen. */
async function away(): Promise<App> {
  // The terminal tab is on: a click on a notification of an agent with no chat opens its terminal, which is what `shown` sees.
  const app = await ready(undefined, { storage: TERMINAL_ON });
  Herdr.setSetting("notify.needsYou", true);
  Herdr.setBackground(true);
  return app;
}

const shownNow = (): TestNotification[] => Herdr.testNotifications();

test("an agent that starts needing you while the window is away is announced with its question and command; a click opens its tab", async () => {
  const app = await away();
  scripted("mixed").become("w1:p4", "blocked", asking("echo hello"));
  await app.waitUntil(() => shownNow().length > 0);

  const [n] = shownNow();
  expect(shownNow()).toHaveLength(1);
  expect(n.title).toBe("Refactor ledger needs you");
  expect(n.body).toContain("Do you want to proceed?");
  expect(n.body).toContain("echo hello");
  expect(n.buttons[0]).toBe("1. Yes");
  expect(shown(app, "Refactor ledger")).toBe(false);

  Herdr.testPressNotification(n.id, "default");
  await app.waitUntil(() => shown(app, "Refactor ledger"));
});

test("a button answers through the same checked path as the answer dock, and the notification goes", async () => {
  const app = await away();
  scripted("mixed").become("w1:p4", "blocked", asking("echo hello"));
  await app.waitUntil(() => shownNow().length > 0);
  const [n] = shownNow();

  Herdr.testPressNotification(n.id, "answer:0");
  await app.waitUntil(() => sentKeys().length > 0);
  expect(sentKeys()).toEqual(["w1:p4: 1 enter"]);
  await app.waitUntil(() => !shownNow()[0].open);
});

test("a button for a question that changed since the notification sends nothing and says so", async () => {
  const app = await away();
  const agents = scripted("mixed");
  agents.become("w1:p4", "blocked", asking("echo hello"));
  await app.waitUntil(() => shownNow().length > 0);
  const [n] = shownNow();

  Herdr.testSetScreen("w1:p4", asking("rm -rf build"));
  Herdr.testPressNotification(n.id, "answer:0");
  await app.waitUntil(() => shownNow()[0].title === "Answer not sent");
  expect(sentKeys()).toEqual([]);
  expect(shownNow()[0].buttons).toEqual([]);
});

test("five agents at once give three notifications and a summary, and a click on the summary opens the board", async () => {
  const app = await away();
  await openAgents(app, FIRST);
  expect(onBoard(app)).toBe(false);
  const agents = scripted("mixed");
  for (const pane of ["w1:p3", "w1:p4", "w1:p5", "w2:p1", "w2:p2"]) agents.become(pane, "blocked", asking("ls"));
  await app.waitUntil(() => shownNow().some((n) => n.title === "5 agents need you"));
  expect(shownNow().filter((n) => n.machine !== undefined)).toHaveLength(3);

  const summary = shownNow().find((n) => n.title === "5 agents need you")!;
  Herdr.testPressNotification(summary.id, "default");
  await app.waitUntil(() => onBoard(app));
  await settle(app);
});

test("with the switch off, or while the window is in front, nothing is announced", async () => {
  const app = await ready();
  const agents = scripted("mixed");
  // In front, switch on.
  Herdr.setSetting("notify.needsYou", true);
  agents.become("w1:p4", "blocked", asking("echo one"));
  await app.waitFor("label:Board, 3 need you");
  // Away, switch off.
  Herdr.setSetting("notify.needsYou", false);
  Herdr.setBackground(true);
  agents.become("w1:p5", "blocked", asking("echo two"));
  await app.waitFor("label:Board, 4 need you");
  // Switched on, away: the four already blocked are seen, a newcomer is news.
  Herdr.setSetting("notify.needsYou", true);
  agents.become("w1:p3", "blocked", asking("echo three"));
  await app.waitUntil(() => shownNow().length > 0);
  expect(shownNow().map((n) => n.title)).toEqual(["Fix login flow needs you"]);
});
