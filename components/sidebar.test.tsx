import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { pressSettled, quiet, showQuiet } from "../app-seam";
import { scripted } from "./board-seam";

/** The sidebar beside lines that say what its buttons did (`sidebar-lab.tsx`), against the scripted herdr's `mixed` fixture: the projects `payments` (5 agents) and `web` (3). */
const lab = (extra: { width?: number; storage?: Record<string, string> } = {}) =>
  open("./sidebar-lab.tsx", {
    width: 1280,
    height: 800,
    platform: "linux",
    clock: {},
    host: { params: { fixture: "mixed" } },
    ...extra,
  });

const row = (name: string) => `label:/^${name}, /`;
/** `web` is quiet in `mixed` (idle and unknown agents only): its header and rows wait behind this line. */
const QUIET = "label:1 quiet project in This computer";
const WEB = "label:/^web, This computer/";
const PAYMENTS = "label:/^payments, This computer, 2 need you/";
const FOLD_PAYMENTS = "label:Fold payments";
/** The search button of the sidebar's first line: shown only in the full sidebar, it opens and closes the field. */
const SEARCH = "label:Search projects and agents";
const FIELD = "label:Search projects";
const ready = async (extra: Parameters<typeof lab>[0] = {}) => {
  const app = await lab(extra);
  await app.waitFor("label:Board, 2 need you");
  // The engine goes on reading panes after the board shows, and each answer re-renders the rows a press would target.
  await quiet(app);
  return app;
};

/** Opens the menu of `options` (a press that did not open it is made again) and presses its entry. */
async function menu(app: App, options: string, entry: string) {
  for (let attempt = 0; attempt < 3 && !app.shows(entry); attempt++) {
    await app.press(`label:${options}`);
    await app.clock!.runFor(150);
  }
  await app.press(entry);
}
const picked = (app: App) => app.texts().find((t) => t.startsWith("picked "));

test("agents are listed under their project in the section of their machine, and each row names the agent, its state, its project and machine", async () => {
  const app = await ready();
  expect(app.shows("label:payments, This computer, 2 need you, 2 working, 1 to review")).toBe(true);
  expect(app.shows("label:payments review, claude, needs you, payments, This computer")).toBe(true);
  expect(app.shows(row("Fix login flow"))).toBe(true);
  // The section names the machine once; no project header repeats it (the screen reader still hears it per project).
  expect(app.shows("label:Fold This computer")).toBe(true);
  expect(app.texts().filter((t) => t === "This computer")).toHaveLength(1);
  // Nothing is pinned: no Pinned section.
  expect(app.shows("label:/^Fold Pinned/")).toBe(false);
});

test("a section's quiet projects wait behind one line that lists them in place and folds them back", async () => {
  const app = await ready();
  expect(app.shows(QUIET)).toBe(true);
  expect(app.shows(WEB)).toBe(false);
  await pressSettled(app, QUIET, WEB);
  expect(app.shows(row("Styling pass"))).toBe(true);
  // The line stays where it was, above what it opened.
  expect(app.shows(QUIET)).toBe(true);
  await app.press(QUIET);
  await app.waitFor(WEB, { state: "gone" });
});

test("a quiet project that starts working leaves the quiet line, below the projects that were there", async () => {
  const app = await ready();
  expect(app.shows(WEB)).toBe(false);
  scripted("mixed").become("w2:p1", "working");
  await app.waitFor(WEB);
  expect(app.shows(QUIET)).toBe(false);
  expect(app.shows(PAYMENTS)).toBe(true);
  // Where it lands (the board's order, the others unmoved) is `lib/sidebar.test.ts`: the headless tree is not in screen order.
});

test("a folded section hides its projects, says how many wait in it, and stays folded after a restart", async () => {
  const app = await ready();
  const twos = () => app.texts().filter((t) => t === "2").length;
  await pressSettled(app, "label:Fold This computer", "label:Unfold This computer, 2 need you");
  expect(app.shows(row("payments review"))).toBe(false);
  expect(app.shows(PAYMENTS)).toBe(false);
  expect(app.shows(QUIET)).toBe(false);
  expect(twos()).toBe(1);
  await app.clock!.runFor(100);
  const saved = app.storage()["herdr.sidebar.v1"];
  expect(JSON.parse(saved).foldedSections).toEqual(["machine:local"]);

  const again = await lab({ storage: { "herdr.sidebar.v1": saved } });
  await again.waitFor("label:Unfold This computer, 2 need you");
  expect(again.shows(row("payments review"))).toBe(false);
  await pressSettled(again, "label:Unfold This computer, 2 need you", "label:Fold This computer");
  await again.waitFor(row("payments review"));
});

test("a search lists the quiet projects' matches without their line", async () => {
  const app = await ready();
  await pressSettled(app, SEARCH, FIELD);
  await app.type(FIELD, "styling");
  await app.waitFor(row("Styling pass"));
  expect(app.shows(QUIET)).toBe(false);
});

test("an expanded project header shows no count, a folded one shows how many wait", async () => {
  const app = await ready();
  // payments: 2 need you, 2 working, 1 to review; nothing but the rows says so while it is open (Board shows no count either).
  const twos = () => app.texts().filter((t) => t === "2").length;
  expect(twos()).toBe(0);
  expect(app.texts().some((t) => /working|to review/.test(t))).toBe(false);
  await pressSettled(app, FOLD_PAYMENTS, "label:Unfold payments");
  await app.waitUntil(() => twos() === 1);
  expect(app.texts().some((t) => /working|to review/.test(t))).toBe(false);
  // web waits for nothing: folded, it says nothing at all.
  await showQuiet(app, "label:Fold web");
  await pressSettled(app, "label:Fold web", "label:Unfold web");
  expect(twos()).toBe(1);
});

test("a project header offers a plus that starts a session in its folder", async () => {
  const app = await ready();
  await showQuiet(app, "label:New agent session in web");
  await app.press("label:New agent session in web");
  expect(app.shows("new session dialog open")).toBe(true);
  expect(app.shows("new session folder /home/dev/web")).toBe(true);
});

test("an agent that stops needing you keeps its place in its project, and the counts follow", async () => {
  const app = await ready();
  scripted("mixed").become("w1:p1", "working");
  await app.waitFor("label:Board, 1 need you");
  await app.waitFor("label:payments, This computer, 1 needs you, 3 working, 1 to review");
  expect(app.shows("label:/^payments review, claude, working, payments/")).toBe(true);
});

test("when nothing needs you the count is gone, not zero", async () => {
  const app = await ready();
  const agents = scripted("mixed");
  agents.become("w1:p1", "working");
  agents.become("w1:p2", "working");
  await app.waitFor("label:Board");
  expect(app.shows("label:/^Board, /")).toBe(false);
  expect(app.shows("label:/^payments, This computer, \\d+ need/")).toBe(false);
});

test("a search narrows to the projects and agents that match every word, ignoring case, and says when none do", async () => {
  const app = await ready();
  await pressSettled(app, SEARCH, FIELD);
  await app.type(FIELD, "AUTH omp");
  expect(app.shows(row("auth"))).toBe(true);
  expect(app.shows(row("payments review"))).toBe(false);
  await app.clear(FIELD);
  await app.type(FIELD, "ledger");
  expect(app.shows(row("Refactor ledger"))).toBe(true);
  expect(app.shows("label:/^web, This computer/")).toBe(false);
  await app.clear(FIELD);
  await app.type(FIELD, "zzz");
  expect(app.shows("No project or agent matches")).toBe(true);
  await app.clear(FIELD);
  expect(app.shows(row("payments review"))).toBe(true);
});

test("the search field shows on demand, and closing it drops the filter with it", async () => {
  const app = await ready();
  expect(app.shows(FIELD)).toBe(false);
  await pressSettled(app, SEARCH, FIELD);
  await app.type(FIELD, "ledger");
  expect(app.shows(row("payments review"))).toBe(false);
  await app.press(SEARCH);
  await app.waitUntil(() => !app.shows(FIELD));
  expect(app.shows(row("payments review"))).toBe(true);
});

test("a folded project hides its agents, keeps its header and chips, and stays folded after a restart", async () => {
  const app = await ready();
  await pressSettled(app, FOLD_PAYMENTS, "label:Unfold payments");
  expect(app.shows(row("Refactor ledger"))).toBe(false);
  expect(app.shows(PAYMENTS)).toBe(true);
  await app.clock!.runFor(100);
  const saved = app.storage()["herdr.sidebar.v1"];
  expect(JSON.parse(saved).foldedProjects).toHaveLength(1);

  const again = await ready({ storage: { "herdr.sidebar.v1": saved } });
  expect(again.shows(row("Refactor ledger"))).toBe(false);
  expect(again.shows("label:Fold This computer")).toBe(true);
  await pressSettled(again, "label:Unfold payments", "label:Fold payments");
  await again.waitFor(row("Refactor ledger"));
});

test("a project's menu pins it into the Pinned section (the project then says so) and starts a chat in its folder", async () => {
  const app = await ready();
  await showQuiet(app, "label:Options for web");
  await menu(app, "Options for web", "Pin to the top");
  await app.waitFor("label:web, This computer, pinned");
  // Pinned is the first section; a pinned project is never quiet, and it is listed once.
  expect(app.shows("label:Fold Pinned")).toBe(true);
  expect(app.shows(QUIET)).toBe(false);
  expect(app.count("label:Fold web")).toBe(1);

  await app.press("label:Options for web");
  expect(app.shows("Unpin")).toBe(true);
  await app.keyboard.press("escape");
  await menu(app, "Options for web", "New agent session here…");
  expect(app.shows("new session dialog open")).toBe(true);
  expect(app.shows("new session folder /home/dev/web")).toBe(true);
});

/** The scripted herdr with repositories in memory (`fixtures/herdr/worktrees.json`): payments-api has a worktree, web is untrusted. */
const repos = () =>
  open("./sidebar-lab.tsx", {
    width: 1280,
    height: 800,
    platform: "linux",
    clock: {},
    host: { params: { fixture: "worktrees" } },
  });

test("a project with several checkouts names each by its branch once herdr said it, the folder's kind until then", async () => {
  const app = await repos();
  await app.waitFor("label:payments-api-hotfix, worktree, branch hotfix/2.1");
  expect(app.shows("label:payments-api, main checkout, branch main")).toBe(true);
});

test("a project's menu starts a new worktree: the new session dialog opens on its folder asking for one", async () => {
  const app = await repos();
  await app.waitFor("label:Options for payments-api");
  await menu(app, "Options for payments-api", "New worktree…");
  expect(app.shows("new session dialog open")).toBe(true);
  expect(app.shows("new session folder /home/dev/payments-api")).toBe(true);
  expect(app.shows("new session worktree true")).toBe(true);
});

test("a project that is not a repository has no New worktree… to choose", async () => {
  const app = await ready();
  await showQuiet(app, "label:Options for web");
  await app.press("label:Options for web");
  await app.clock!.runFor(150);
  expect(app.enabled("New worktree…")).toBe(false);
});

test("the top buttons open what they say: new agent session, settings", async () => {
  const app = await ready();
  await app.press("label:New agent session");
  expect(app.shows("new session dialog open")).toBe(true);
  expect(app.shows("new session folder none")).toBe(true);
  await app.press("label:Settings");
  expect(app.shows("settings page look")).toBe(true);
});

test("agents are picked with the box at the row's right end, and Shift picks everything from the last pick", async () => {
  const app = await ready();
  await app.press("label:Select payments review");
  expect(picked(app)).toBe("picked 1");
  await app.press("label:Select payments review");
  expect(picked(app)).toBe("picked 0");
  await app.press("label:Select payments review");
  await app.keyboard.down("shift");
  await app.press("label:Select Fix login flow");
  await app.keyboard.up("shift");
  // payments review, auth (needs you) and Fix login flow (to review): the rows between the two picks.
  expect(picked(app)).toBe("picked 3");
});

test("a window of 960 keeps the full sidebar, at its narrow width", async () => {
  const app = await ready({ width: 960 });
  expect(app.shows(SEARCH)).toBe(true);
  expect(app.shows("label:payments review, claude, needs you, payments, This computer")).toBe(true);
});

test("in a narrow window the sidebar is a rail of project tiles: no list of agents, every project named with what it needs", async () => {
  const app = await ready({ width: 760 });
  expect(app.shows(SEARCH)).toBe(false);
  expect(app.shows("label:payments, This computer, 2 need you, 2 working, 1 to review")).toBe(true);
  expect(app.shows("label:web, This computer")).toBe(true);
  expect(app.shows("label:Board, 2 need you")).toBe(true);
  expect(app.shows(row("payments review"))).toBe(false);
});

test("a rail tile opens its project's agents in a popover, and pressing one opens that agent", async () => {
  const app = await ready({ width: 760 });
  await app.press("label:payments, This computer, 2 need you, 2 working, 1 to review");
  await app.waitFor("label:/^payments review, claude, needs you, payments/");
  expect(app.shows(row("Fix login flow"))).toBe(true);
});

test("a rail popover stays open when the keyboard moves into it, onto its Show project button", async () => {
  const app = await ready({ width: 760 });
  await app.press("label:payments, This computer, 2 need you, 2 working, 1 to review");
  await app.waitFor("label:/^payments review, claude, needs you, payments/");
  // Past the pointer's own focus grace, then Tab onto the first control of the popup.
  await app.clock!.runFor(600);
  await app.keyboard.press("tab");
  await app.clock!.runFor(300);
  expect(app.shows(row("Fix login flow"))).toBe(true);
  expect(app.shows("label:Show payments")).toBe(true);
});

test("a wide window can collapse the sidebar to the rail and bring it back", async () => {
  const app = await ready();
  await app.press("label:Collapse sidebar");
  expect(app.shows(SEARCH)).toBe(false);
  await app.press("label:Expand sidebar");
  expect(app.shows(SEARCH)).toBe(true);
});

test("a right click on an agent or a project copies its name or folder", async () => {
  const app = await ready();
  await app.rightClick(row("payments review"));
  await app.chooseMenuItem("Copy name");
  await app.waitUntil(() => app.clipboard() === "payments review");
  await app.rightClick(row("payments review"));
  await app.chooseMenuItem("Copy folder");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("/"));
  await app.rightClick(FOLD_PAYMENTS);
  await app.chooseMenuItem("Copy name");
  await app.waitUntil(() => app.clipboard() === "payments");
});

test("with every machine online the sidebar has no footer text, and a machine that cannot be reached adds one amber line", async () => {
  const app = await ready();
  expect(app.shows("label:Machines")).toBe(false);
  expect(app.texts().some((t) => /^(Connected|Not connected)/.test(t))).toBe(false);
  await app.press("Add an unreachable machine");
  await app.waitUntil(() => app.shows("label:/^Build box, (Not connected|Connecting)/"));
  expect(app.shows("label:Machines")).toBe(true);
  expect(app.shows("label:Settings")).toBe(true);
});

/** The scripted herdr's `projects` fixture: payments-api, payments-api-hotfix and web have something going on, notes is quiet. */
const projects = (extra: { storage?: Record<string, string> } = {}) =>
  open("./sidebar-lab.tsx", {
    width: 1280,
    height: 800,
    platform: "linux",
    clock: {},
    host: { params: { fixture: "projects" } },
    ...extra,
  });
/** Whether `entry` of the menu of `project` takes a press; the menu is closed again. */
async function canChoose(app: App, project: string, entry: string): Promise<boolean> {
  await app.press(`label:Options for ${project}`);
  await app.clock!.runFor(150);
  const on = app.enabled(entry);
  await app.keyboard.press("escape");
  return on;
}

test("a project's menu moves it up, down or to the top of its section, the ends do nothing, and the order survives a restart", async () => {
  const app = await projects();
  await app.waitFor("label:Options for web");
  await quiet(app);
  // The board's order (by name) until moved: payments-api, then web.
  expect(await canChoose(app, "payments-api", "Move up")).toBe(false);
  expect(await canChoose(app, "payments-api", "Move to top")).toBe(false);
  expect(await canChoose(app, "web", "Move down")).toBe(false);

  await menu(app, "Options for web", "Move up");
  await app.clock!.runFor(150);
  expect(await canChoose(app, "web", "Move up")).toBe(false);
  expect(await canChoose(app, "web", "Move to top")).toBe(false);
  expect(await canChoose(app, "web", "Move down")).toBe(true);
  expect(await canChoose(app, "payments-api", "Move down")).toBe(false);

  const again = await projects({ storage: { "herdr.sidebar.v1": app.storage()["herdr.sidebar.v1"] } });
  await again.waitFor("label:Options for web");
  await quiet(again);
  expect(await canChoose(again, "web", "Move up")).toBe(false);
  expect(await canChoose(again, "payments-api", "Move down")).toBe(false);
  await menu(again, "Options for payments-api", "Move to top");
  await again.clock!.runFor(150);
  expect(await canChoose(again, "payments-api", "Move up")).toBe(false);
});
