import { expect, open, test } from "nsh/test";

/** The engine seam end to end: the Rust engine against the scripted herdr of `fixtures/herdr/mixed.json`. */
const DESKTOP = { width: 1280, height: 800 };

test("the board has the sections and counts of the fixture, and the window title says how many need you", async () => {
  const app = await open("./herdr-lab.tsx", DESKTOP);
  await app.waitFor("Link: online");
  await app.waitFor("Needs you: 2");
  expect(app.shows("To review: 1")).toBe(true);
  expect(app.shows("Working: 2")).toBe(true);
  expect(app.shows("Idle: 3")).toBe(true);
  expect(app.shows("Title: (2) Herdr Desktop")).toBe(true);
  expect(app.shows("Status: 2 need you · 1 to review · 2 working · heard just now")).toBe(true);
  expect(app.shows("Machines: This computer")).toBe(true);
});

test("a blocked agent's question and a card's last row arrive after their read, with the risk of each answer", async () => {
  const app = await open("./herdr-lab.tsx", DESKTOP);
  await app.waitFor("Question: Do you want to proceed?");
  const options = app.texts().find((t) => t.startsWith("Options: "))!;
  expect(options).toContain("1. Yes |");
  expect(options).toContain("standing permission");
  await app.waitFor("Preview: ⠋ Working (2m 14s · esc to interrupt)");
});

test("an event reaches the screen as a tick and the screen pulls what changed", async () => {
  const app = await open("./herdr-lab.tsx", DESKTOP);
  await app.waitFor("Needs you: 2");
  expect(app.texts().find((t) => t.startsWith("Working rows: "))).not.toContain("renamed by test");
  await app.press("Rename working agent");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Working rows: ") && t.includes("renamed by test")));
});

test("answering sends the keys of the option the person saw, and nothing when the question is not the one they saw", async () => {
  const app = await open("./herdr-lab.tsx", DESKTOP);
  await app.waitFor("Question: Do you want to proceed?");

  await app.press("Answer with an old digest");
  await app.waitFor("answer changed");
  expect(app.shows("nothing sent")).toBe(true);

  await app.press("Answer after the screen changed");
  await app.waitFor("answer changed");
  expect(app.shows("nothing sent")).toBe(true);
});

test("the answer the person saw is the one that is sent", async () => {
  const app = await open("./herdr-lab.tsx", DESKTOP);
  await app.waitFor("Question: Do you want to proceed?");
  await app.press("Answer first option");
  await app.waitFor("answer sent");
  // Compared as data: the order of an object's keys on the wire is not what the person asked for.
  const sent = app.texts().find((t) => t.startsWith("sent "))!;
  expect(JSON.parse(sent.slice("sent ".length))).toEqual({ keys: ["1", "enter"], pane_id: "w1:p1" });
});

test("finished agents leave 'to review' once reviewed, and a machine that cannot be reached is refused with a reason", async () => {
  const app = await open("./herdr-lab.tsx", DESKTOP);
  await app.waitFor("To review: 1");
  await app.press("Review finished");
  await app.waitFor("To review: 0");
  expect(app.shows("Idle: 4")).toBe(true);

  await app.press("Save a bad machine");
  await app.waitUntil(() => app.texts().some((t) => t.includes("invalid destination")));
});
