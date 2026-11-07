import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800 };

test("a required select left empty stops the submit and says why; choosing a value lets it through", async () => {
  const app = await open("./select-form-probe.tsx", DESKTOP);
  await app.press("Save");
  expect(app.texts()).toContain("submitted:0");
  expect(app.texts()).toContain("Enter a value.");
  await app.press("label:Model: not selected, required, invalid");
  await app.wait(100);
  await app.press("label:4.0");
  await app.wait(50);
  expect(app.texts()).not.toContain("Enter a value.");
  await app.press("Save");
  expect(app.texts()).toContain("submitted:1");
});
