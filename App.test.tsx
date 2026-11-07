import { expect, open, test } from "nsh/test";

test("opens", async () => {
  const app = await open("./App.tsx");
  expect(app.texts()).toContain("Herdr Desktop");
});
