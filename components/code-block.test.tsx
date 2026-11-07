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

test("line numbers and wrapping are toggles that stay reachable without hovering", async () => {
  const app = await lab({ part: "one", lang: "rust" });
  await app.waitFor("Line numbers");
  expect(app.texts().includes("10")).toBe(false);
  await app.press("Line numbers");
  await app.waitUntil(() => app.texts().includes("10"));
  await app.press("Line numbers");
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
