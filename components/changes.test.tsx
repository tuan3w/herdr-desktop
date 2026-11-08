import { Git, Herdr } from "herdr-desktop/native";
import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { changeEntries } from "#components/changes-diff";
import { headings } from "#components/changes-list";
import { changeText } from "#components/diff-block";
import type { MenuAction, MenuEntry, MenuGroup } from "#kit";
import type { Item } from "#lib/changes";

const DESKTOP = { width: 1280, height: 800, platform: "linux" as const, clock: {} };

/**
 * The Changes tab against a synthetic repository the test seam builds in the data directory (`Git.testRepo`) with the real
 * git: README.md and src/auth.ts and src/session.ts and assets/logo.png (binary) modified, src/legacy.ts deleted, src/token.ts
 * moved to src/tokens.ts and edited, docs/notes.md and src/rate-limit.ts new. Two agents of the scripted herdr work in it:
 * `omp` waits for an answer, `claude` is done. A file is found by its label, which starts with its path.
 */
const lab = (params: Record<string, unknown> = {}, size = DESKTOP) =>
  open("./changes-lab.tsx", { ...size, host: { params } });

const esc = (path: string) => path.replace(/[./]/g, "\\$&");
const file = (path: string) => `label:/^${esc(path)}, /`;
const MINUS = "\u2212";

/** Settles the list, then waits for the first read of the repository to be drawn. */
async function ready(params: Record<string, unknown> = {}, size = DESKTOP): Promise<App> {
  const app = await lab(params, size);
  await app.waitFor("label:Changed files");
  await app.clock!.runFor(300);
  return app;
}

const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));

async function select(app: App, path: string) {
  await app.press(file(path));
  await app.waitFor(`label:/^Diff of ${esc(path)}/`);
  await app.clock!.runFor(100);
}

test("the changed files are grouped by what happened, each with how much changed in it", async () => {
  const app = await ready();
  const at = (t: string) => app.texts().indexOf(t);
  expect(at("Modified")).toBeGreaterThan(-1);
  expect(at("Modified")).toBeLessThan(at("Deleted"));
  expect(at("Deleted")).toBeLessThan(at("Renamed"));
  expect(at("Renamed")).toBeLessThan(at("Untracked"));
  expect(app.shows(`label:src/auth.ts, modified, +8 ${MINUS}2`)).toBe(true);
  expect(app.shows(`label:src/legacy.ts, deleted, +0 ${MINUS}4`)).toBe(true);
  expect(app.shows(`label:src/tokens.ts, renamed, from src/token.ts, +1 ${MINUS}1`)).toBe(true);
  expect(app.shows(`label:src/rate-limit.ts, new, not in git, +17 ${MINUS}0`)).toBe(true);
  expect(app.shows("label:assets/logo.png, modified, binary, 12 bytes")).toBe(true);
  // The header says the totals and the progress once, as parts of one line.
  expect(said(app, "8 files")).toBe(true);
  expect(said(app, "+38")).toBe(true);
  expect(said(app, `${MINUS}8`)).toBe(true);
  expect(said(app, "0 of 8 reviewed")).toBe(true);
  // One letter per file in its own column; the row's accessible name keeps the word.
  expect(said(app, "M")).toBe(true);
  expect(said(app, "U")).toBe(true);
});

test("the first file's change is drawn at once, and a press shows another", async () => {
  const app = await ready();
  await app.waitFor("label:/^Diff of README\\.md, 4 added, 0 removed/");
  await select(app, "src/auth.ts");
  expect(app.shows("label:/^Diff of src\\/auth\\.ts, 8 added, 2 removed/")).toBe(true);
  expect(app.shows("label:/^Diff of README/")).toBe(false);
});

test("j and k walk the files in the order of the list and stop at its ends", async () => {
  const app = await ready();
  const order = [
    "README.md",
    "assets/logo.png",
    "src/auth.ts",
    "src/session.ts",
    "src/legacy.ts",
    "src/tokens.ts",
    "docs/notes.md",
    "src/rate-limit.ts",
  ];
  const front = () => order.find((p) => app.shows(`label:Change to ${p}`));
  expect(front()).toBe("README.md");
  await app.keyboard.press("k");
  expect(front()).toBe("README.md");
  for (const p of order.slice(1)) {
    await app.keyboard.press("j");
    await app.clock!.runFor(50);
    expect(front()).toBe(p);
  }
  await app.keyboard.press("j");
  expect(front()).toBe("src/rate-limit.ts");
  await app.keyboard.press("k");
  expect(front()).toBe("docs/notes.md");
});

test("n and p step through the changes of a file, wrapping, and say which one", async () => {
  const app = await ready();
  await select(app, "src/auth.ts");
  await app.keyboard.press("n");
  await app.clock!.runFor(50);
  const first = app.texts().find((t) => /^Change 1 of \d+$/.test(t));
  expect(first).toBeDefined();
  const total = Number(first!.replace(/^Change 1 of /, ""));
  expect(total).toBeGreaterThan(2);
  await app.keyboard.press("n");
  await app.clock!.runFor(50);
  expect(app.shows(`Change 2 of ${total}`)).toBe(true);
  await app.keyboard.press("p");
  await app.keyboard.press("p");
  await app.clock!.runFor(50);
  expect(app.shows(`Change ${total} of ${total}`)).toBe(true);
});

test("x marks the file reviewed, and a change to the file takes the mark back", async () => {
  const app = await ready();
  expect(app.shows("label:/^README\\.md, modified, .*, reviewed$/")).toBe(false);
  await app.keyboard.press("x");
  await app.clock!.runFor(50);
  expect(app.shows("label:/^README\\.md, modified, .*, reviewed$/")).toBe(true);
  expect(said(app, "1 of 8 reviewed")).toBe(true);
  expect(app.shows("Mark not reviewed")).toBe(true);
  // The agent edits it again: the review was of the earlier change.
  const before = Git.testRead("README.md");
  Git.testWrite("README.md", `${before}\nOne more line.\n`);
  await app.keyboard.press("r");
  await app.waitUntil(() => app.shows("label:/^README\\.md, modified, \\+6/"));
  expect(app.shows("label:/^README\\.md, modified, .*, reviewed$/")).toBe(false);
  expect(said(app, "1 of 8 reviewed")).toBe(false);
});

test("the filter narrows the files as you type, and says when nothing matches", async () => {
  const app = await ready();
  await app.type("label:Filter changed files", "auth");
  await app.clock!.runFor(100);
  expect(app.shows(file("src/auth.ts"))).toBe(true);
  expect(app.shows(file("README.md"))).toBe(false);
  await app.clear("label:Filter changed files");
  await app.type("label:Filter changed files", "zzzz");
  await app.clock!.runFor(100);
  expect(said(app, 'No changed file matches "zzzz"')).toBe(true);
});

test("a heading folds its group, and the count stays", async () => {
  const app = await ready();
  await app.press("label:Untracked, 2 files");
  await app.clock!.runFor(100);
  expect(app.shows(file("src/rate-limit.ts"))).toBe(false);
  expect(app.shows("label:Untracked, 2 files")).toBe(true);
  await app.press("label:Untracked, 2 files");
  await app.clock!.runFor(100);
  expect(app.shows(file("src/rate-limit.ts"))).toBe(true);
});

test("a new file, a deleted file and a binary one each have a view of their own", async () => {
  const app = await ready();
  await select(app, "src/rate-limit.ts");
  expect(app.shows("new file")).toBe(true);
  await select(app, "src/legacy.ts");
  expect(app.shows("label:/^Diff of src\\/legacy\\.ts, 0 added, 4 removed/")).toBe(true);
  await app.press(file("assets/logo.png"));
  await app.waitFor("Binary file");
  expect(app.shows("label:/^Diff of assets/")).toBe(false);
});

test("a note on a change is kept with where it is, shown under the file and counted in the header", async () => {
  const app = await ready();
  await select(app, "src/auth.ts");
  await app.keyboard.press("n");
  await app.keyboard.press("c");
  await app.waitFor("label:/^Note on change 1 of \\d+, line \\d+/");
  await app.type("label:/^Note on change 1/", "Name this limit.");
  await app.submit("label:/^Note on change 1/");
  await app.clock!.runFor(100);
  expect(app.shows("label:/^Note on src\\/auth\\.ts:\\d+(-\\d+)?: Name this limit\\./")).toBe(true);
  expect(app.shows("Send 1 note")).toBe(true);
  expect(app.shows("label:/^Note on change/")).toBe(false);
  // The same change again edits its note instead of stacking a second.
  await app.press("Add note");
  await app.waitFor("label:/^Note on change 1/");
  expect(app.value("label:/^Note on change 1/")).toBe("Name this limit.");
  await app.keyboard.press("escape");
  await app.clock!.runFor(100);
  expect(app.shows("label:/^Note on change/")).toBe(false);
  expect(app.shows("Send 1 note")).toBe(true);
});

test("the notes are previewed whole before anything is sent, and go to the agent as one message", async () => {
  const app = await ready();
  await select(app, "src/auth.ts");
  await app.keyboard.press("n");
  await app.keyboard.press("c");
  await app.type("label:/^Note on change 1/", "Name this limit.");
  await app.submit("label:/^Note on change 1/");
  await app.press("label:Next change");
  await app.press("Add note");
  await app.type("label:/^Note on change 2/", "Why a minute?");
  await app.submit("label:/^Note on change 2/");
  await app.clock!.runFor(100);
  expect(app.shows("Send 2 notes")).toBe(true);
  await app.keyboard.press("mod+enter");
  await app.waitFor("Send 2 notes to the agent");
  await app.clock!.runFor(200);
  expect(Herdr.testRequests("pane.send_input")).toEqual([]);
  const texts = app.texts();
  const message = texts.find((t) => /^Notes on your changes in \S+ \(2\):/.test(t));
  expect(message).toBeDefined();
  expect(message).toContain("Name this limit.");
  expect(message).toContain("Why a minute?");
  expect(message).toMatch(/src\/auth\.ts:\d+/);
  expect(message).toContain("\n> +");
  // `omp` is waiting for an answer: a message typed into its terminal would answer the question, so it cannot be chosen.
  // The scripted herdr moves its agents into the repository a moment after the lab starts: the list fills in then.
  await app.waitUntil(() => app.enabled("label:Send notes"));
  await app.press("label:Send notes");
  await app.waitUntil(() => Herdr.testRequests("pane.send_input").length === 1);
  const [sent] = Herdr.testRequests("pane.send_input");
  // The checkout's name (`payments` once the board knows the project, else the folder's) is the one thing that may differ.
  const unnamed = (text: string) => text.replace(/ in \S+ \(2\)/, " (2)");
  expect(sent.params).toMatchObject({ pane_id: "w1:p3", keys: ["enter"] });
  const params = sent.params;
  const text = params && typeof params === "object" && "text" in params ? String(params.text) : "";
  expect(unnamed(text)).toBe(unnamed(message!));
  await app.clock!.runFor(200);
  expect(app.shows("Send 2 notes")).toBe(false);
});

test("with two agents that can take the notes the person says which, and Send waits for that", async () => {
  const app = await ready({ both: true });
  await select(app, "src/auth.ts");
  await app.keyboard.press("n");
  await app.keyboard.press("c");
  await app.type("label:/^Note on change 1/", "Check this.");
  await app.submit("label:/^Note on change 1/");
  await app.keyboard.press("mod+enter");
  await app.waitFor("Which agent?");
  expect(app.enabled("label:Send notes")).toBe(false);
  await app.waitFor("label:/, omp, terminal,/");
  await app.press("label:/, omp, terminal,/");
  expect(app.enabled("label:Send notes")).toBe(true);
});

test("with no agent in the folder the message can still be copied, and there is nothing to send to", async () => {
  const app = await ready({ alone: true });
  await select(app, "src/auth.ts");
  await app.keyboard.press("n");
  await app.keyboard.press("c");
  await app.type("label:/^Note on change 1/", "Check this.");
  await app.submit("label:/^Note on change 1/");
  await app.keyboard.press("mod+enter");
  await app.waitFor("Send 1 note to the agent");
  expect(said(app, "No agent is running in this folder")).toBe(true);
  expect(app.enabled("label:Send notes")).toBe(false);
  await app.press("Copy message");
  expect(app.clipboard()).toMatch(/^Notes on your changes in \S+ \(1\):\n\nsrc\/auth\.ts:/);
  expect(Herdr.testRequests("pane.send_input")).toEqual([]);
});

test("a note on a file that changed afterwards says so in the preview", async () => {
  const app = await ready();
  await select(app, "src/auth.ts");
  await app.keyboard.press("n");
  await app.keyboard.press("c");
  await app.type("label:/^Note on change 1/", "Check this.");
  await app.submit("label:/^Note on change 1/");
  Git.testWrite("src/auth.ts", `${Git.testRead("src/auth.ts")}// later\n`);
  await app.keyboard.press("r");
  await app.waitUntil(() => said(app, "This file changed after you wrote this note"));
  await app.keyboard.press("mod+enter");
  await app.waitFor("Send 1 note to the agent");
  expect(said(app, "on a file that changed since you wrote it")).toBe(true);
});

test("reverting a file asks first and names what is lost; cancel keeps it, and Undo brings it back", async () => {
  const app = await ready();
  app.onDialog(() => "Cancel");
  await app.press("label:More for this file");
  await app.clock!.runFor(150);
  await app.press("Revert this file\u2026");
  await app.clock!.runFor(100);
  expect(app.dialogs()[0]).toMatchObject({ title: "Revert README.md?" });
  expect(app.dialogs()[0].message).toContain(`+4 ${MINUS}0`);
  expect(Git.testRead("README.md")).toContain("Limits");

  app.onDialog(() => "Revert file");
  await app.press("label:More for this file");
  await app.clock!.runFor(150);
  await app.press("Revert this file\u2026");
  await app.waitUntil(() => Git.testRead("README.md")?.includes("Limits") === false);
  await app.waitUntil(() => !app.shows(file("README.md")));
  expect(app.shows("Reverted README.md")).toBe(true);
  await app.press("Undo");
  await app.waitUntil(() => Git.testRead("README.md")?.includes("Limits") === true);
  await app.waitUntil(() => app.shows(file("README.md")));
});

test("reverting one change takes back those lines only, and Undo puts them back", async () => {
  const app = await ready();
  await select(app, "src/auth.ts");
  await app.keyboard.press("n");
  await app.clock!.runFor(50);
  const whole = Git.testRead("src/auth.ts")!;
  app.onDialog(() => "Revert change");
  await app.press("label:More for this file");
  await app.clock!.runFor(150);
  await app.press("Revert this change\u2026");
  await app.waitUntil(() => Git.testRead("src/auth.ts") !== whole);
  const now = Git.testRead("src/auth.ts")!;
  expect(now).not.toContain('import { RateLimiter } from "./rate-limit";');
  expect(now).toContain("const limiter = new RateLimiter");
  await app.waitFor("Undo");
  await app.press("Undo");
  await app.waitUntil(() => Git.testRead("src/auth.ts") === whole);
});

test("a repository with no changes says so, and a folder that is not one explains", async () => {
  const clean = await lab({ kind: "clean" });
  await clean.waitFor("No changes");
  expect(clean.shows("label:Changed files")).toBe(false);
  const plain = await lab({ kind: "plain" });
  await plain.waitFor("This folder is not a git repository");
  expect(plain.shows("This folder is not a git repository")).toBe(true);
  expect(said(plain, "git init")).toBe(true);
  expect(plain.shows("Try again")).toBe(false);
});

test("a merge conflict is listed first, flagged, and its view says what to do instead of showing nothing", async () => {
  const app = await ready({ kind: "conflict" });
  const texts = app.texts();
  expect(texts.indexOf("Merge conflicts")).toBeLessThan(texts.indexOf("Modified"));
  expect(app.shows("label:/^src\\/a\\.ts, conflicted/")).toBe(true);
  expect(app.shows("This file has merge conflicts")).toBe(true);
});

test("a very big change opens cut at a limit and says so; Show all lifts it", async () => {
  const app = await ready({ kind: "big" });
  await app.waitFor("label:/^Diff of src\\/big\\.ts/");
  expect(said(app, "Showing the first 6000 lines of a bigger change.")).toBe(true);
  await app.press("Show all");
  await app.waitUntil(() => app.shows("label:/^Diff of src\\/big\\.ts, 5000 added, 5000 removed/"), { timeout: 30000 });
  expect(said(app, "Showing the first 6000 lines")).toBe(false);
});

test("hundreds of changed files are listed from a virtual list, a screenful at a time", async () => {
  const app = await ready({ kind: "many" });
  expect(said(app, "522 files")).toBe(true);
  const drawn = app.count("label:/^module\\d+\\.ts/") + app.count("label:/^src\\/gen\\/module\\d+\\.ts, /");
  expect(drawn).toBeGreaterThan(5);
  expect(drawn).toBeLessThan(80);
});

test("the tab reads git again while it is in front, and not at all while it is hidden", async () => {
  const app = await ready();
  expect(app.shows(file("src/brand-new.ts"))).toBe(false);
  Git.testWrite("src/brand-new.ts", "export const x = 1;\n");
  await app.clock!.runFor(5200);
  await app.waitFor(file("src/brand-new.ts"));

  const hidden = await lab({ hidden: true });
  await hidden.clock!.runFor(12000);
  expect(hidden.shows("label:Changed files")).toBe(false);
  expect(hidden.shows("label:Reading the changes")).toBe(true);
});

test("the files stack in a narrow window: the list first, then the change with a way back", async () => {
  const app = await ready({}, { ...DESKTOP, width: 760 });
  expect(app.shows(file("src/auth.ts"))).toBe(true);
  expect(app.shows("label:/^Change to /")).toBe(false);
  await app.press(file("src/auth.ts"));
  await app.waitFor("label:Change to src/auth.ts");
  expect(app.shows(file("README.md"))).toBe(false);
  await app.press("Back to the files");
  await app.waitFor(file("README.md"));
});

test("the group headings stay at the top of the list while their files scroll under them", () => {
  const items = [{ kind: "head" }, { kind: "file" }, { kind: "file" }, { kind: "head" }, { kind: "file" }] as Item[];
  expect(headings(items)).toEqual([0, 3]);
  expect(headings([])).toEqual([]);
});

test("the header says what is reviewed before git answers, and the branch once it has", async () => {
  // A tab that is not in front reads nothing: its header is what a person sees before git answers.
  const waiting = await lab({ hidden: true });
  expect(said(waiting, "Reading changes\u2026")).toBe(true);
  expect(said(waiting, "payments")).toBe(true);
  const app = await ready();
  expect(said(app, "Reading changes\u2026")).toBe(false);
  expect(said(app, "\u00b7 main")).toBe(true);
  expect(said(app, "\u00b7 by 2 agents")).toBe(true);
});

test("a long file name is not cut by a count: the row holds it whole under its own label", async () => {
  const app = await ready({ kind: "many" });
  expect(app.shows("label:/^module1\\.ts, /") || app.shows("label:/^src\\/gen\\/module\\d+\\.ts, /")).toBe(true);
});

test("the diff header says which change is in view, and how many before the first step", () => {
  expect(changeText(null, 0)).toBe("");
  expect(changeText(null, 5)).toBe("5 changes");
  expect(changeText(null, 1)).toBe("1 change");
  expect(changeText(1, 5)).toBe("Change 2 of 5");
});

test("the file's menu puts a divider before each revert, radios for the context and an icon on every row", () => {
  const none = () => {};
  const entries: MenuEntry[] = changeEntries({
    context: 12,
    setContext: none,
    canRevertChange: false,
    reload: none,
    note: none,
    revertChange: none,
    revertFile: none,
  });
  const danger = entries.flatMap((e, i) => (typeof e === "object" && "danger" in e && e.danger ? [i] : []));
  expect(danger).toHaveLength(2);
  for (const i of danger) expect(entries[i - 1]).toBe("separator");
  expect((entries[danger[1]] as MenuAction).label).toBe("Revert this file\u2026");
  expect((entries[danger[0]] as MenuAction).disabled).toBe(true);
  const group = entries.find((e) => typeof e === "object" && "items" in e && !("type" in e)) as MenuGroup;
  const radios = group.items[0] as Extract<MenuEntry, { type: "radio" }>;
  expect(radios.value).toBe("12");
  expect(radios.items.map((r) => r.label)).toEqual(["3 lines", "12 lines", "Whole file"]);
  for (const e of entries) if (typeof e === "object") expect((e as MenuAction | MenuGroup).icon).toBeDefined();
});
