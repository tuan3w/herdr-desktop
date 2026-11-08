import { Herdr, Sessions } from "herdr-desktop/native";
import { afterEach, expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { endSessions } from "./chat-parts-seam";

/**
 * `New agent session`'s Checkout row and New worktree flow against a scripted herdr whose repositories live in memory
 * (`fixtures/herdr/worktrees*.json`): nothing here touches a real herdr, repository or worktree.
 */
const DESKTOP = { width: 1280, height: 900 };
const REPO = "/home/dev/payments-api";

afterEach(() => endSessions());
const form = (params: Record<string, unknown> = {}) => open("./new-worktree-lab.tsx", { ...DESKTOP, host: { params } });

const FOLDER = "label:Folder *";
const CHECKOUT = "Checkout";
const HERE = "label:Checkout: This folder · main";
const BRANCH = "label:Branch";
const OMP = "label:Agent *: omp";

const opened = (app: App) =>
  app
    .texts()
    .find((t) => t.startsWith("Opened local/"))
    ?.slice("Opened local/".length);
const created = () => Herdr.testRequests("worktree.create").map((r) => r.params);

/** Types a folder and waits until herdr answered for it. */
async function inRepo(app: App, folder = REPO) {
  await app.waitFor(OMP);
  await app.type(FOLDER, folder);
  await app.waitFor(HERE);
}

async function chooseNewWorktree(app: App) {
  await app.press(HERE);
  await app.waitFor("label:New worktree…");
  await app.press("label:New worktree…");
  await app.waitFor(BRANCH);
}

/** Replaces the prefilled suggestion with what a person would type. */
async function setBranch(app: App, branch: string) {
  await app.clear(BRANCH);
  await app.type(BRANCH, branch);
}

test("the Checkout row appears for a folder in a repository and lists its checkouts by folder and branch", async () => {
  const app = await form();
  await inRepo(app);
  await app.press(HERE);
  await app.waitFor("label:payments-api-hotfix · hotfix/2.1");
  expect(app.shows("label:New worktree…")).toBe(true);
});

test("a folder outside any repository gets no Checkout row and no complaint", async () => {
  const app = await form();
  await app.waitFor(OMP);
  await app.type(FOLDER, "/home/dev/elsewhere");
  await app.waitUntil(() => Herdr.testRequests("worktree.list").length > 0);
  expect(app.shows(CHECKOUT)).toBe(false);
  expect(app.shows("not inside a git repository")).toBe(false);
});

test("a herdr without worktrees leaves the row out", async () => {
  const app = await form({ fixture: "empty" });
  await app.waitFor(OMP);
  await app.type(FOLDER, REPO);
  await app.waitUntil(() => Herdr.testRequests("worktree.list").length > 0);
  expect(app.shows(CHECKOUT)).toBe(false);
});

test("an untrusted repository says so and is never trusted from here", async () => {
  const app = await form();
  await app.waitFor(OMP);
  await app.type(FOLDER, "/home/dev/web");
  await app.waitUntil(() => app.texts().some((t) => t.includes("This app never trusts a repository for you.")));
  expect(app.shows(CHECKOUT)).toBe(false);
  expect(Herdr.testRequests(null).every((r) => !("trust_repository" in (r.params as object)))).toBe(true);
});

test("New worktree… asks for a branch, prefilled in herdr's shape and one the repository does not have", async () => {
  const app = await form();
  await inRepo(app);
  await chooseNewWorktree(app);
  expect(app.value(BRANCH)).toMatch(/^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  expect(created()).toEqual([]);
});

test("an invalid branch blocks Start with the rule's sentence and sends nothing", async () => {
  const app = await form();
  await inRepo(app);
  await chooseNewWorktree(app);
  await setBranch(app, "a;x");
  await app.press("Start");
  await app.waitFor("Use letters, digits and - _ . / + in a branch name.");
  await setBranch(app, "a b");
  await app.press("Start");
  await app.waitFor("No spaces or control characters in a branch name.");
  await setBranch(app, "--force");
  await app.press("Start");
  await app.waitFor("A branch name can't start with -.");
  expect(created()).toEqual([]);
  expect(opened(app)).toBeUndefined();
});

test("Start makes the worktree first, then starts the session in it", async () => {
  const app = await form();
  await inRepo(app);
  await chooseNewWorktree(app);
  await setBranch(app, "feature/fresh");
  await app.press("Start");
  await app.waitUntil(() => opened(app) !== undefined, { timeout: 20_000 });
  expect(created()).toEqual([{ cwd: REPO, branch: "feature/fresh", focus: false }]);
  // The session ran where herdr said the worktree is (the scripted herdr names /tmp), not in the typed folder.
  const id = opened(app)!;
  const view = Sessions.view("local", id);
  expect(view?.cwd).toBeTruthy();
  expect(Herdr.setting("newSession.folder.local")).toBe(REPO);
});

test("a session that does not start keeps the worktree chosen, and Start again does not make a second", async () => {
  const app = await form({ fixture: "worktrees-missing" });
  await inRepo(app);
  await chooseNewWorktree(app);
  await setBranch(app, "feature/fresh");
  await app.press("Start");
  await app.waitFor("The worktree payments-api-fresh was created; Start again to use it.");
  expect(app.value(FOLDER)).toBe(REPO);
  expect(created().length).toBe(1);
  await app.waitFor("label:Checkout: payments-api-fresh · feature/fresh");
  await app.press("Start");
  await app.waitFor("The worktree payments-api-fresh was created; Start again to use it.");
  expect(created().length).toBe(1);
});

test("a refused worktree says what herdr said and keeps what was typed", async () => {
  const app = await form();
  await inRepo(app);
  await chooseNewWorktree(app);
  await setBranch(app, "hotfix/2.1");
  await app.type("label:First message (optional)", "keep me");
  await app.press("Start");
  await app.waitFor("Nothing was started. Change the branch, or choose This folder.");
  expect(app.texts().some((t) => t.includes("already exists"))).toBe(true);
  expect(app.value(BRANCH)).toBe("hotfix/2.1");
  expect(app.value("label:First message (optional)")).toBe("keep me");
  expect(opened(app)).toBeUndefined();
});

test("a project's New worktree… opens the form with New worktree… already chosen", async () => {
  const app = await form({ project: { machine: "local", folder: REPO, worktree: true } });
  await app.waitFor(BRANCH);
  expect(app.value(FOLDER)).toBe(REPO);
  expect(app.value(BRANCH)).toMatch(/^worktree\//);
});
