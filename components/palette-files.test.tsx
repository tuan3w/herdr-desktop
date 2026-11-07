import { expect, open, test } from "nsh/test";

/**
 * Files in the palette, in its lab: the `payments` project is moved to a synthetic folder, `mod+p`'s scope searches it.
 */
const lab = () => open("./palette-lab.tsx", { width: 1280, height: 800, platform: "linux" });
const FILES = "label:Search files of this project";

test("the files scope finds a file of the project by letters of its name and Enter opens it in the viewer", async () => {
  const app = await lab();
  // The board arrives from the scripted herdr a moment after the lab opens: files are searched in a project.
  await app.wait(600);
  await app.press("Find a file");
  await app.waitFor(FILES);
  await app.wait(300);
  await app.type(FILES, "ledg");
  await app.waitFor("label:/^ledger\\.py/");
  await app.keyboard.press("enter");
  await app.wait(300);
  expect(app.texts().some((t) => t.startsWith("viewer opened") && t.endsWith("ledger.py"))).toBe(true);
});

test("a query that matches no file says so", async () => {
  const app = await lab();
  // The board arrives from the scripted herdr a moment after the lab opens: files are searched in a project.
  await app.wait(600);
  await app.press("Find a file");
  await app.wait(300);
  await app.type(FILES, "zzzzqq");
  await app.waitFor("No file matches");
});
