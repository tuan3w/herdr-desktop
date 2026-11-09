import { Herdr, Sessions } from "herdr-desktop/native";
import { afterEach, expect, test } from "nsh/test";

import { ENTRY, onBoard, quiet, seeded, settle } from "../app-seam";
import projects from "../fixtures/herdr/projects.json";
import { endSessions } from "./chat-parts-seam";

ENTRY.path = "../App.tsx";

/**
 * A chat session next to the terminal agents, against the scripted keeper and the `projects` fixture: the session is
 * started in a folder that is the checkout of the fixture's `web` project, so it must land in that project's card.
 */
const FOLDER = "/tmp";

// A keeper outlives the app by design: a test that started a session ends it.
afterEach(() => endSessions());

async function withChat() {
  const app = await seeded("projects");
  await quiet(app);
  // The scripted herdr says the `web` repository is checked out in a folder that exists here, where a session can run.
  const snapshot = JSON.parse(JSON.stringify(projects.snapshot)) as typeof projects.snapshot;
  for (const ws of snapshot.workspaces as {
    workspace_id: string;
    worktree?: { repo_root: string; checkout_path: string };
  }[]) {
    if (ws.worktree && ws.workspace_id.startsWith("w3")) {
      ws.worktree.repo_root = FOLDER;
      ws.worktree.checkout_path = FOLDER;
    }
  }
  Herdr.testSetSnapshot(snapshot);
  Herdr.testPush({ event: "workspace_updated", data: {} });
  const routes = await Sessions.probe("local");
  const ref = await Sessions.start("local", { agent: routes[0]!.id, cwd: FOLDER });
  return { app, ref };
}

test("a chat session joins the project whose checkout holds its folder", async () => {
  const { app } = await withChat();
  await app.waitFor("label:/^tmp, .*, idle, web, This computer/", { timeout: 10000 });
  expect(app.shows("label:web, This computer, 1 needs you, 1 working")).toBe(true);
});

test("opening a chat row opens its chat tab", async () => {
  const { app } = await withChat();
  await app.waitFor("label:/^tmp, .*, idle, web, This computer/", { timeout: 10000 });
  await app.press("label:/^tmp, .*, idle, web, This computer/ >> nth=0");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
  expect(onBoard(app)).toBe(false);
});

test("renaming a chat from the palette names it in the sidebar and the header, and an empty name brings the agent's own back", async () => {
  const { app } = await withChat();
  const named = (name: string) => `label:/^${name}, .*, idle, web, This computer/`;
  await app.waitFor(named("tmp"), { timeout: 10000 });
  await app.press(`${named("tmp")} >> nth=0`);
  await settle(app);

  const FIELD = "label:Search agents, projects and commands";
  const rename = async (to: string) => {
    await app.keyboard.press("mod+p");
    await settle(app);
    await app.clear(FIELD);
    await app.type(FIELD, "Rename pane");
    await settle(app);
    await app.press("label:/^Rename pane…/");
    await settle(app);
    await app.clear("label:/^Name$/");
    if (to) await app.type("label:/^Name$/", to);
    await app.press("text:Rename");
  };

  await rename("Billing");
  await app.waitFor(named("Billing"), { timeout: 10000 });
  await app.waitFor("label:Billing, session details");

  await rename("");
  await app.waitFor(named("tmp"), { timeout: 10000 });
  await app.waitFor("label:tmp, session details");
});

test("a chat's row offers Rename in its actions, and the name it is given shows on the row", async () => {
  const { app } = await withChat();
  const FIELD = "label:Search agents, projects and commands";
  await app.waitFor("label:/^tmp, .*, idle, web, This computer/", { timeout: 10000 });
  await app.keyboard.press("mod+p");
  await settle(app);
  await app.clear(FIELD);
  await app.type(FIELD, "tmp");
  await settle(app);
  await app.keyboard.press("mod+p");
  await settle(app);
  // a chat session used to keep its own name here; the name is the person's to change
  expect(app.enabled("label:/^Rename…/")).toBe(true);
  await app.press("label:/^Rename…/");
  await settle(app);
  await app.clear("label:/^Name$/");
  await app.type("label:/^Name$/", "Ledger chat");
  await app.press("text:Rename");
  await app.waitFor("label:/^Ledger chat, .*, idle, web, This computer/", { timeout: 10000 });
});
