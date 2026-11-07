import { open, test } from "nsh/test";

/**
 * Files in the palette, in its lab: the `payments` project is moved to a synthetic folder, `mod+p`'s scope searches it.
 */
const lab = () => open("./palette-lab.tsx", { width: 1280, height: 800, platform: "linux" });
const FILES = "label:Search files of this project";

test("the files scope finds a file of the project by letters of its name and Enter opens it in the viewer", async () => {
  const app = await lab();
  // The board arrives from the scripted herdr after the lab opens (later on a slow machine): files are searched in a project.
  await app.waitFor("project folder ready", { timeout: 30_000 });
  await app.press("Find a file");
  await app.waitFor(FILES);
  await app.type(FILES, "ledg");
  await app.waitFor("label:/^ledger\\.py/", { timeout: 30_000 });
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("viewer opened") && t.endsWith("ledger.py")), {
    timeout: 30_000,
  });
});

test("a query that matches no file says so", async () => {
  const app = await lab();
  // The board arrives from the scripted herdr after the lab opens (later on a slow machine): files are searched in a project.
  await app.waitFor("project folder ready", { timeout: 30_000 });
  await app.press("Find a file");
  await app.waitFor(FILES);
  await app.type(FILES, "zzzzqq");
  await app.waitFor("No file matches", { timeout: 30_000 });
});
