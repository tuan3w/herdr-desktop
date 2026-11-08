import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "macos" } as const;

async function lab() {
  const app = await open("./menus.fixture.tsx", DESKTOP);
  await app.wait(100);
  return app;
}

test("a checkbox and a radio stay open when chosen, and their state follows the owner", async () => {
  const app = await lab();
  await app.press("label:Display options");
  expect(app.shows("label:Show finished sessions")).toBe(true);
  await app.press("label:Show finished sessions");
  expect(app.texts()).toContain("Finished: on");
  // Still open, and the row now says it is chosen.
  expect(app.shows("label:Show finished sessions, checked")).toBe(true);
  await app.press("label:Show finished sessions, checked");
  expect(app.texts()).toContain("Finished: off");

  expect(app.shows("label:By date, selected")).toBe(true);
  await app.press("label:By name");
  expect(app.texts()).toContain("Sort: name");
  expect(app.shows("label:By name, selected")).toBe(true);
  expect(app.shows("label:By date, selected")).toBe(false);
  // An action closes the menu.
  await app.press("label:Open");
  expect(app.texts()).toContain("Runs: 1");
  expect(app.shows("label:By name")).toBe(false);
});

test("a disabled row takes the highlight and does nothing when chosen", async () => {
  const app = await lab();
  await app.press("label:Display options");
  // Rows: Open, Show finished sessions, 3 radios, Pane title, Locked.
  await app.keyboard.press("l");
  await app.keyboard.press("o");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("Runs: 0");
  expect(app.shows("label:Locked")).toBe(true);
});

test("typing finds a row, a space continues the word, and without a word it chooses", async () => {
  const app = await lab();
  await app.press("label:Display options");
  for (const key of ["p", "a", "n", "e", "space", "t"]) await app.keyboard.press(key);
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("Runs: 10");
  expect(app.shows("label:Pane title")).toBe(false);
});

test("Up on the first row goes to the last, unless the menu does not loop; End and Home are the ends", async () => {
  const app = await lab();
  await app.press("label:Display options");
  await app.keyboard.press("down");
  await app.keyboard.press("up");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("Runs: 10000");

  const flat = await lab();
  await flat.press("label:No loop");
  await flat.keyboard.press("down");
  await flat.keyboard.press("up");
  await flat.keyboard.press("up");
  await flat.keyboard.press("enter");
  expect(flat.texts()).toContain("Runs: 1");

  await flat.press("label:No loop");
  await flat.keyboard.press("end");
  await flat.keyboard.press("home");
  await flat.keyboard.press("enter");
  expect(flat.texts()).toContain("Runs: 2");
});

test("a long menu is scrolled by the keys: End brings the last row into view, Home the first", async () => {
  const app = await lab();
  await app.press("label:Choose agent");
  expect(app.shows("label:Agent 001, selected")).toBe(true);
  expect(app.shows("label:Agent 080")).toBe(false);
  await app.keyboard.press("end");
  await app.wait(100);
  expect(app.shows("label:Agent 080")).toBe(true);
  await app.keyboard.press("home");
  await app.wait(100);
  expect(app.shows("label:Agent 001, selected")).toBe(true);
  await app.keyboard.press("pagedown");
  await app.keyboard.press("enter");
  expect(app.texts()).not.toContain("Agent: a1");
});

test("Escape closes the submenu first, and then the menu", async () => {
  const app = await lab();
  await app.press("label:Display options");
  await app.keyboard.press("m");
  await app.keyboard.press("o");
  await app.keyboard.press("right");
  expect(app.shows("label:Move to: Laptop")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("label:Move to: Laptop")).toBe(false);
  expect(app.shows("label:Open")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("label:Open")).toBe(false);
});

test("a select of 500 machines opens on its value, finds a machine by typing and chooses it", async () => {
  const app = await lab();
  await app.press("label:Target machine: Machine 250");
  await app.wait(100);
  expect(app.shows("label:Machine 250, selected")).toBe(true);
  expect(app.shows("label:Machine 001")).toBe(false);
  for (const key of ["m", "a", "c", "h", "i", "n", "e", "space", "4", "0", "7"]) await app.keyboard.press(key);
  await app.keyboard.press("enter");
  await app.wait(50);
  expect(app.texts()).toContain("Machine: m407");
  expect(app.shows("label:Machine 407, selected")).toBe(false);
  expect(app.shows("label:Target machine: Machine 407")).toBe(true);
});

test("a select's last option is reached with End and chosen with Return", async () => {
  const app = await lab();
  await app.press("label:Target machine: Machine 250");
  await app.wait(100);
  await app.keyboard.press("end");
  await app.wait(100);
  expect(app.shows("label:Machine 500")).toBe(true);
  await app.keyboard.press("enter");
  await app.wait(50);
  expect(app.texts()).toContain("Machine: m500");
});

test("a multiple select ticks several and stays open", async () => {
  const app = await lab();
  await app.press("label:Machines: Machine 002");
  await app.wait(100);
  await app.press("label:Machine 004");
  expect(app.texts()).toContain("Machines: m2,m4");
  expect(app.shows("label:Machine 004, checked")).toBe(true);
  await app.press("label:Machine 002, checked");
  expect(app.texts()).toContain("Machines: m4");
});

test("a read-only select opens and chooses nothing, a disabled one does not open", async () => {
  const app = await lab();
  await app.press("label:Read only: Machine 001, read only");
  await app.wait(100);
  expect(app.shows("label:Machine 003")).toBe(true);
  await app.press("label:Machine 003");
  expect(app.shows("label:Machine 003")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("label:Read only: Machine 001, read only")).toBe(true);

  expect(app.enabled("label:Disabled: Machine 001")).toBe(false);
});

test("a select with groups lists their headings, and a disabled option cannot be chosen", async () => {
  const app = await lab();
  await app.press("label:Machine group: Laptop");
  await app.wait(100);
  expect(app.shows("Office")).toBe(true);
  expect(app.shows("Cloud")).toBe(true);
  // The arrow reaches the disabled option, Return on it chooses nothing and the list stays open.
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  expect(app.shows("label:Cloud VM")).toBe(true);
  expect(app.texts()).not.toContain("Machine group: Build box");
  await app.press("label:Cloud VM");
  await app.wait(50);
  expect(app.shows("label:Machine group: Cloud VM")).toBe(true);
});

test("a select inside a dialog opens, chooses and leaves the dialog open", async () => {
  const app = await lab();
  await app.press("Open dialog");
  await app.wait(300);
  await app.press("label:Agent in dialog: not selected");
  await app.wait(100);
  expect(app.shows("label:Agent 012")).toBe(true);
  await app.press("label:Agent 012");
  await app.wait(50);
  expect(app.shows("label:Agent in dialog: Agent 012")).toBe(true);
  expect(app.shows("Dialog with a list")).toBe(true);
});

test("a context menu opens where the row is pressed and its checkbox keeps it open", async () => {
  const app = await lab();
  await app.rightClick("Right-click test row");
  await app.wait(100);
  expect(app.shows("label:Show finished sessions")).toBe(true);
  await app.press("label:Show finished sessions");
  expect(app.texts()).toContain("Finished: on");
  expect(app.shows("label:Show finished sessions, checked")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("label:Show finished sessions, checked")).toBe(false);
});

test("an accelerator runs its item and closes the menu only while that menu is open", async () => {
  const app = await lab();
  await app.keyboard.press("p");
  expect(app.texts()).toContain("Acted: none");
  await app.press("label:Accelerated");
  await app.keyboard.press("r");
  expect(app.texts()).toContain("Acted: rename");
  expect(app.shows("label:Pin")).toBe(false);
  // Closed again: the letter is nobody's.
  await app.keyboard.press("d");
  expect(app.texts()).toContain("Acted: rename");
});

test("a disabled item ignores its accelerator and the menu stays open", async () => {
  const app = await lab();
  await app.press("label:Accelerated");
  await app.keyboard.press("l");
  expect(app.texts()).toContain("Acted: none");
  expect(app.shows("label:Pin")).toBe(true);
});

test("in a menu with accelerators a letter without one still finds a row, and a live word is not hijacked", async () => {
  const app = await lab();
  await app.press("label:Accelerated");
  await app.keyboard.press("s");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("Acted: share");

  await app.press("label:Accelerated");
  await app.keyboard.press("s");
  // "sa" is still a word being typed: it finds nothing and does not archive.
  await app.keyboard.press("a");
  expect(app.texts()).toContain("Acted: share");
  expect(app.shows("label:Pin")).toBe(true);
});

test("an accelerator pressed while a text field has the keyboard runs the item and types nothing", async () => {
  const app = await lab();
  await app.type("label:Typed note", "ab");
  expect(app.texts()).toContain("Note: ab");
  await app.press("label:Accelerated");
  await app.keyboard.press("r");
  expect(app.texts()).toContain("Acted: rename");
  expect(app.texts()).toContain("Note: ab");
});
