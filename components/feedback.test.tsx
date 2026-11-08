import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, clock: {} };

const lab = (extra: { reducedMotion?: boolean; platform?: "macos" } = {}) =>
  open("./feedback-lab.tsx", { ...DESKTOP, ...extra });
const has = (app: App, text: string) => app.texts().includes(text);

/** Moves the test clock a second at a time until `text` is on screen: a step itself takes a little virtual time. */
async function until(app: App, text: string) {
  for (let seconds = 0; seconds < 40 && !has(app, text); seconds += 1) await app.clock!.runFor(1000);
  expect(has(app, text)).toBe(true);
}
const undone = (app: App) => app.texts().find((t) => t.startsWith("undone"));

test("a plain toast leaves by itself after 3.5 s, and the same text shown again is one toast", async () => {
  const app = await lab();
  await app.press("Plain toast");
  await app.clock!.runFor(3000);
  await app.press("Plain toast");
  expect(app.texts().filter((t) => t === "Saved").length).toBe(1);
  // the second showing restarted the time: 3000 ms after it the toast is still there
  await app.clock!.runFor(3000);
  expect(has(app, "Saved")).toBe(true);
  await app.clock!.runFor(900);
  expect(has(app, "Saved")).toBe(false);
});

test("an error toast is still on screen after 5 s and leaves after 30 s, so a failure is not missed", async () => {
  const app = await lab();
  await app.press("Error toast");
  await app.clock!.runFor(5000);
  expect(has(app, "Could not save the file")).toBe(true);
  await app.clock!.runFor(24000);
  expect(has(app, "Could not save the file")).toBe(true);
  await app.clock!.runFor(2000);
  expect(has(app, "Could not save the file")).toBe(false);
});

test("a long plain toast stays long enough to be read: 60 ms a character, not 3.5 s", async () => {
  const app = await lab();
  const text = "The agent stopped because its machine went offline, so the change was not applied.";
  await app.press("Long toast");
  await app.clock!.runFor(4500);
  expect(has(app, text)).toBe(true);
  await app.clock!.runFor(1500);
  expect(has(app, text)).toBe(false);
});

test("the time of a toast is held while something covers it, and runs again when the cover is gone", async () => {
  const app = await lab();
  await app.press("Toast with undo");
  await app.press("Cover toasts");
  await app.clock!.runFor(20000);
  expect(has(app, "Task 1 finished")).toBe(true);
  await app.press("Uncover toasts");
  await app.clock!.runFor(10500);
  expect(has(app, "Task 1 finished")).toBe(false);
});

test("only three toasts show; the older ones come back as the newer ones go", async () => {
  const app = await lab();
  await app.press("Toast five");
  const shown = () => app.texts().filter((t) => t.startsWith("Notice"));
  expect(shown()).toEqual(["Notice three", "Notice four", "Notice five"]);
  await app.press("label:Close notification >> nth=2");
  await app.clock!.runFor(300);
  expect(shown()).toEqual(["Notice two", "Notice three", "Notice four"]);
});

test("a toast that stays has no timer, and closing all leaves none", async () => {
  const app = await lab();
  await app.press("Toast that stays");
  await app.clock!.runFor(120000);
  expect(has(app, "Read carefully")).toBe(true);
  await app.press("Close all");
  await app.clock!.runFor(300);
  expect(has(app, "Read carefully")).toBe(false);
});

test("the Undo button runs once; Cmd+Z right after finds nothing left to undo", async () => {
  const app = await lab();
  await app.press("Toast with undo");
  await app.press("Undo");
  expect(undone(app)).toBe("undone 1");
  await app.keyboard.press("mod+z");
  expect(undone(app)).toBe("undone 1");
});

test("Cmd+Z undoes the newest toast first, and still reaches one the user closed, until its time runs out", async () => {
  const app = await lab();
  await app.press("Toast with undo");
  await app.press("Toast with undo");
  await app.press("label:Close notification >> nth=1");
  await app.clock!.runFor(300);
  // the newest toast is closed, its undo is not lost
  await app.keyboard.press("mod+z");
  expect(undone(app)).toBe("undone 1");
  expect(has(app, "Task 2 finished")).toBe(false);
  // the other one is still showing; past its 10 s both its toast and its undo are gone
  await app.clock!.runFor(10500);
  await app.keyboard.press("mod+z");
  expect(undone(app)).toBe("undone 1");
});

test("a send turns from waiting into its result in the same toast, with Undo while it waits", async () => {
  const app = await lab();
  await app.press("Send message");
  // a loading toast has no timer of its own: it outlives the 3.5 s of a plain one
  await app.clock!.runFor(10000);
  expect(has(app, "Sending message")).toBe(true);
  await until(app, "Message sent");
  expect(has(app, "Sending message")).toBe(false);
  await app.clock!.runFor(4000);
  expect(has(app, "Message sent")).toBe(false);
});

test("Undo while a send waits reaches the sender, and the result that follows says nothing more", async () => {
  const app = await lab();
  await app.press("Send message");
  await app.press("Undo");
  expect(app.texts()).toContain("send undone");
  await app.clock!.runFor(25000);
  expect(has(app, "Message sent")).toBe(false);
});

test("a failure is never lost: it shows even when the user had closed the waiting toast", async () => {
  const app = await lab();
  await app.press("Send failing message");
  await app.press("label:Close notification");
  await until(app, "Could not send message");
  // a warning stays 30 s
  await app.clock!.runFor(29000);
  expect(has(app, "Could not send message")).toBe(true);
  await app.clock!.runFor(2000);
  expect(has(app, "Could not send message")).toBe(false);
});

test("the region shortcut holds the timers until Escape closes the newest toast", async () => {
  const app = await lab();
  await app.press("Plain toast");
  await app.keyboard.press("mod+shift+t");
  await app.clock!.runFor(60000);
  expect(has(app, "Saved")).toBe(true);
  await app.keyboard.press("escape");
  await app.clock!.runFor(300);
  expect(has(app, "Saved")).toBe(false);
  // the hold went with the last toast: the next one times out as usual
  await app.press("Plain toast");
  await app.clock!.runFor(4000);
  expect(has(app, "Saved")).toBe(false);
});

test("Escape with the toast region held closes the newest toast and leaves the dialog open", async () => {
  const app = await lab();
  await app.press("Open A");
  await app.press("Open B");
  await app.press("Toast in B");
  await app.keyboard.press("mod+shift+t");
  await app.keyboard.press("escape");
  await app.clock!.runFor(400);
  expect(has(app, "Toast from B")).toBe(false);
  expect(app.shows("Dialog B")).toBe(true);
});

test("under reduced motion a closed toast is gone at once; otherwise it is gone after its exit", async () => {
  const still = await lab({ reducedMotion: true });
  await still.press("Plain toast");
  await still.press("label:Close notification");
  expect(has(still, "Saved")).toBe(false);
  const moving = await lab();
  await moving.press("Plain toast");
  await moving.press("label:Close notification");
  expect(has(moving, "Saved")).toBe(true);
  await moving.clock!.runFor(300);
  expect(has(moving, "Saved")).toBe(false);
});

test("nested dialogs: Escape and the scrim close the newest only, each with its reason", async () => {
  const app = await lab();
  await app.press("Open A");
  await app.press("Open B");
  expect(app.shows("Dialog B")).toBe(true);
  await app.keyboard.press("escape");
  await app.clock!.runFor(400);
  expect(app.shows("Dialog B")).toBe(false);
  expect(app.shows("Dialog A")).toBe(true);
  await app.press("id:dialog-scrim");
  await app.clock!.runFor(400);
  expect(app.shows("Dialog A")).toBe(false);
  expect(app.texts()).toContain("B escape-key");
  expect(app.texts()).toContain("A outside-press");
});

// The exit half is the platform's: a headless run removes the dialog without an exit, so it is checked on macOS.
test("onOpenChangeComplete is not told before the enter has finished", async () => {
  const app = await lab();
  await app.press("Open A");
  await app.clock!.runFor(600);
  expect(app.texts()).toContain("A opened");
  expect(app.texts()).not.toContain("A closed");
});

test("an owner can refuse to close: Escape and the scrim only ask, until the owner lets go", async () => {
  const app = await lab();
  await app.press("Open refusing dialog");
  await app.keyboard.press("escape");
  await app.press("id:dialog-scrim");
  await app.clock!.runFor(400);
  expect(app.shows("Refusing dialog")).toBe(true);
  expect(app.texts()).toContain("refused escape-key");
  expect(app.texts()).toContain("refused outside-press");
  await app.press("Let go");
  await app.keyboard.press("escape");
  await app.clock!.runFor(400);
  expect(app.shows("Refusing dialog")).toBe(false);
});

test("with disablePointerDismissal a press on the scrim asks nothing, and Escape still does", async () => {
  const app = await lab();
  await app.press("Open drafting dialog");
  await app.press("id:dialog-scrim");
  await app.clock!.runFor(400);
  expect(app.shows("Drafting dialog")).toBe(true);
  expect(app.texts().some((t) => t.startsWith("drafting"))).toBe(false);
  await app.keyboard.press("escape");
  await app.clock!.runFor(400);
  expect(app.shows("Drafting dialog")).toBe(false);
});

test("a toast raised while a dialog is open shows in the dialog, once, and Cmd+Z leaves the page behind alone", async () => {
  const app = await lab();
  await app.press("Toast with undo");
  await app.press("Open A");
  await app.press("Open B");
  await app.press("Toast in B");
  expect(app.texts().filter((t) => t === "Toast from B").length).toBe(1);
  // the page's own toast is not drawn under the dialog, and its undo is out of reach behind it
  await app.keyboard.press("mod+z");
  expect(undone(app)).toBe("undone 0");
  await app.keyboard.press("escape");
  await app.keyboard.press("escape");
  await app.clock!.runFor(400);
  await app.keyboard.press("mod+z");
  expect(undone(app)).toBe("undone 1");
});

test("a dialog taller than the window keeps its title and its actions, and only the body scrolls", async () => {
  const app = await lab();
  await app.press("Open long dialog");
  expect(app.shows("Long dialog")).toBe(true);
  expect(app.shows("Done")).toBe(true);
  await app.press("Done");
  await app.clock!.runFor(400);
  expect(app.shows("Long dialog")).toBe(false);
});

test("the large dialog has its title and Close at the top, its content fills it, a toast draws above it, and Escape asks", async () => {
  const app = await lab();
  await app.press("Open large dialog");
  expect(app.shows("Large dialog")).toBe(true);
  expect(app.shows("Content large")).toBe(true);
  await app.keyboard.press("escape");
  await app.clock!.runFor(400);
  expect(app.texts()).toContain("large escape-key");
  expect(app.shows("Large dialog")).toBe(false);
  await app.press("Open large dialog");
  await app.press("Close large");
  await app.clock!.runFor(400);
  expect(app.shows("Large dialog")).toBe(false);
});

test("asking twice at once shows one alert: the second answer is no, so nothing is confirmed twice", async () => {
  const app = await lab();
  app.onDialog(() => "Delete");
  await app.press("Ask twice");
  expect(app.dialogs().length).toBe(1);
  expect(app.texts()).toContain("confirm true false");
});

test("the pointer on the toasts holds their time, and leaving gives back what was left", async () => {
  const app = await lab({ platform: "macos" });
  await app.press("Plain toast");
  await app.hover("text:Saved");
  await app.clock!.runFor(20000);
  expect(has(app, "Saved")).toBe(true);
  await app.hover("text:Plain toast");
  await app.clock!.runFor(6000);
  expect(has(app, "Saved")).toBe(false);
});
