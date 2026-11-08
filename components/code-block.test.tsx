import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

/** The code lab (`code-lab.tsx`) with one part of it: `one` (a sample opened), `languages` (folded samples), `stream`, `diff`. */
const lab = (params: Record<string, unknown>) => open("./code-lab.tsx", { ...DESKTOP, host: { params } });

/** Whether some text on screen holds `part`. */
const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));

test("a block is a group named by its language and size, and its code is text a screen reader can read", async () => {
  const app = await lab({ part: "one", lang: "ts" });
  await app.waitFor("label:/^Code, TypeScript, \\d+ lines$/");
  expect(said(app, "readFile")).toBe(true);
  expect(said(app, "TIMEOUT_MS")).toBe(true);
});

test("a long block folds to a few lines and says how many it hides; pressing it opens and closes", async () => {
  const app = await lab({ part: "languages", from: 1, count: 1, fold: 6 });
  await app.waitFor("label:/^Show all \\d+ lines$/");
  expect(said(app, "export class Reader")).toBe(false);
  await app.press("label:/^Show all \\d+ lines$/");
  await app.waitFor("Show fewer lines");
  await app.press("Show fewer lines");
  await app.waitFor("label:/^Show all \\d+ lines$/");
});

test("copy puts the whole code on the clipboard, says Copied, and goes back to Copy", async () => {
  const app = await lab({ part: "languages", from: 1, count: 1, fold: 6 });
  await app.waitFor("Copy code");
  await app.press("Copy code");
  await app.waitFor("Copied");
  // The whole block, not the folded part.
  expect(app.clipboard()).toContain("export class Reader");
  await app.waitUntil(() => app.shows("Copy code"));
});

test("line numbers are a check in the options menu, which stays reachable without hovering", async () => {
  const app = await lab({ part: "one", lang: "rust" });
  await app.waitFor("Code options");
  expect(app.texts().includes("10")).toBe(false);
  await app.press("label:Code options");
  await app.waitFor("label:Line numbers");
  await app.press("label:Line numbers");
  await app.waitFor("label:Line numbers, checked");
  await app.waitUntil(() => app.texts().includes("10"));
  await app.press("label:Line numbers, checked");
  await app.waitUntil(() => !app.texts().includes("10"));
});

test("a block that is still being written never folds, and folds once it is whole", async () => {
  const app = await lab({ part: "stream", lang: "ts", chunk: 24 });
  await app.waitUntil(() => said(app, "import { readFile }"));
  expect(app.shows("label:/^Show all/")).toBe(false);
  await app.waitFor("label:/^Show all \\d+ lines$/");
});

test("a diff counts what changed in words, folds what did not, and steps through its changes", async () => {
  const app = await lab({ part: "diff" });
  await app.waitFor("label:/^Diff of src\\/reader\\.ts, \\d+ added, \\d+ removed$/");
  expect(said(app, "7 unchanged lines")).toBe(true);
  await app.press("Next change");
  await app.waitUntil(() => said(app, "Change 1 of"));
});

test("opening a fold of a diff shows the lines it held", async () => {
  const app = await lab({ part: "diff" });
  await app.waitFor("label:Show 7 unchanged lines");
  expect(said(app, "export const e = 5;")).toBe(false);
  await app.press("label:Show 7 unchanged lines");
  await app.waitUntil(() => said(app, "export const e = 5;"));
});

test("a patch is read as one file's change with its hunks", async () => {
  const app = await lab({ part: "patch" });
  await app.waitFor("label:/^Diff of src\\/ledger\\.rs, 4 added, 3 removed$/");
  expect(said(app, "@@ -12,9 +12,12 @@ impl Account {")).toBe(true);
});

test("a block of thousands of lines scrolls past the rows first mounted, mounting only the rows near the view", async () => {
  const app = await lab({ part: "long", lines: 3000, numbers: true });
  await app.waitFor("label:/^Code, Rust, 3\\d\\d\\d lines$/");
  const numbers = () =>
    app
      .texts()
      .filter((t) => /^\d+$/.test(t))
      .map(Number);
  const first = Math.max(...numbers());
  expect(numbers().length).toBeLessThan(150);
  // A recycled cell must follow its row: before the fix the list stopped at the rows it first mounted.
  for (let i = 0; i < 6; i++) await app.scroll("label:/^Code, Rust, \\d+ lines$/", 2000);
  await app.waitUntil(() => Math.max(...numbers()) > first + 150);
  expect(numbers().length).toBeLessThan(150);
});

test("a right click on a code block offers Copy code, which copies the whole code", async () => {
  const app = await lab({ part: "languages", from: 1, count: 1, fold: 6 });
  await app.waitFor("Copy code");
  await app.rightClick("label:/^Code, /");
  await app.waitUntil(() => (app.menu() ?? []).some((m) => m.label === "Copy code"));
  await app.chooseMenuItem("Copy code");
  await app.waitUntil(() => (app.clipboard() ?? "").includes("export class Reader"));
});

test("a right click on a diff offers the new version, copied as written", async () => {
  const app = await lab({ part: "diff" });
  await app.waitFor("label:/^Diff of src\\/reader\\.ts/");
  await app.rightClick("label:/^Diff of src\\/reader\\.ts/");
  await app.waitUntil(() => (app.menu() ?? []).some((m) => m.label === "Copy new version"));
  await app.chooseMenuItem("Copy new version");
  await app.waitUntil(() => (app.clipboard() ?? "").includes("export async function load(key: string, signal"));
});

/** The line numbers on screen: a block of thousands of lines mounts only the rows near its view. */
const numbersOn = (app: App) =>
  app
    .texts()
    .filter((t) => /^\d+$/.test(t))
    .map(Number);

test("a block asked to show a far line scrolls there once its view exists, without a request from the person", async () => {
  const app = await lab({ part: "goto", lines: 3000, line: 1500 });
  await app.waitUntil(() => numbersOn(app).includes(1500));
  expect(numbersOn(app).includes(1)).toBe(false);
});

test("asking again for the line already shown scrolls back to it after the reader scrolled away", async () => {
  const app = await lab({ part: "goto", lines: 3000, line: 1500 });
  await app.waitUntil(() => numbersOn(app).includes(1500));
  // Away from it: the same `goTo` alone changes nothing, so only the repeated request can bring the reader back.
  for (let i = 0; i < 4; i++) await app.scroll("label:/^Code, Rust, \\d+ lines$/", 2000);
  await app.waitUntil(() => !numbersOn(app).includes(1500));
  await app.press("Show the line again");
  await app.waitUntil(() => numbersOn(app).includes(1500));
});
