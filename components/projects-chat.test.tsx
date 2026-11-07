import { Herdr, Sessions } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import { ENTRY, onBoard, seeded, settle } from "../app-seam";
import projects from "../fixtures/herdr/projects.json";

ENTRY.path = "../App.tsx";

/**
 * A chat session next to the terminal agents, against the scripted keeper and the `projects` fixture: the session is
 * started in a folder that is the checkout of the fixture's `web` project, so it must land in that project's card.
 */
const FOLDER = "/tmp";

async function withChat() {
  const app = await seeded("projects");
  await app.waitFor("heard just now", { timeout: 5000 }).catch(() => undefined);
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

test("a chat session joins the project whose checkout holds its folder, and its row says it is a chat", async () => {
  const { app } = await withChat();
  await app.waitFor("label:/^tmp, .*, idle, web, This computer/", { timeout: 10000 });
  expect(app.shows("label:web, This computer, 1 needs you, 1 working")).toBe(true);
  expect(app.texts().some((t) => t.endsWith("· chat"))).toBe(true);
});

test("opening a chat row opens its chat tab", async () => {
  const { app } = await withChat();
  await app.waitFor("label:/^tmp, .*, idle, web, This computer/", { timeout: 10000 });
  await app.press("label:/^tmp, .*, idle, web, This computer/ >> nth=0");
  await settle(app);
  expect(app.count("role:tab")).toBe(2);
  expect(onBoard(app)).toBe(false);
});
