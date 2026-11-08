import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800 };
const NAME = "label:Name *";

test("a rename starts from the current name, cannot be confirmed unchanged, and submits what was typed without its edges", async () => {
  const app = await open("./machines-lab.tsx", DESKTOP);
  await app.press("Rename workspace");
  expect(app.value(NAME)).toBe("payments");
  expect(app.enabled("Rename")).toBe(false);
  // Enter on the unchanged name does nothing: no empty rename, no close
  await app.submit(NAME);
  expect(app.texts()).toContain("no name");
  expect(app.shows("Rename")).toBe(true);

  // spaces around the same name are still the same name
  await app.type(NAME, "  ");
  expect(app.enabled("Rename")).toBe(false);

  await app.clear(NAME);
  await app.type(NAME, "  billing api  ");
  expect(app.enabled("Rename")).toBe(true);
  await app.press("Rename");
  expect(app.texts()).toContain("named billing api");
  await app.waitFor("Rename", { state: "gone" });
});

test("a new name cannot be empty: the button stays pressable and says why under the field instead of submitting", async () => {
  const app = await open("./machines-lab.tsx", DESKTOP);
  await app.press("New workspace");
  // A dead button cannot say what is wrong (design/dialogs.md): it is pressable, and the press explains.
  expect(app.enabled("Create")).toBe(true);
  await app.type(NAME, "   ");
  const before = app.texts();
  await app.press("Create");
  expect(app.texts()).toContain("no name");
  expect(app.shows("Create")).toBe(true);
  // a message under the field says why nothing happened
  const said = app.texts().filter((t) => !before.includes(t));
  expect(said.length).toBe(1);
  // the message goes as soon as the field is right, and Enter submits
  await app.type(NAME, "docs");
  expect(app.texts()).not.toContain(said[0]);
  expect(app.enabled("Create")).toBe(true);
  await app.submit(NAME);
  expect(app.texts()).toContain("named docs");
});

test("cancelling submits nothing, and the next opening starts from its own initial name, not the last draft", async () => {
  const app = await open("./machines-lab.tsx", DESKTOP);
  await app.press("Rename workspace");
  await app.type(NAME, " draft");
  await app.press("Cancel");
  expect(app.texts()).toContain("no name");
  await app.waitFor("Rename", { state: "gone" });
  await app.press("Rename workspace");
  expect(app.value(NAME)).toBe("payments");
});
