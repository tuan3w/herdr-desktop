import { Files, Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import {
  ENTRY,
  FIRST,
  nameOf,
  openTerminals,
  ready,
  saved,
  SECOND,
  seeded,
  settle,
  sidebarRow,
  terminal,
  TERMINAL_ON,
} from "../app-seam";

ENTRY.path = "../App.tsx";

/**
 * The terminal tab (`components/terminal-tab.tsx`) of the whole app against the scripted herdr's `mixed` fixture. The program
 * is always the synthetic one `Herdr.testSetProgram` sets: a test never starts the herdr client, and the tab's own command
 * (`lib/terminal-command.ts`) has its table of shapes in `terminal-command.test.ts`. The terminal tab is off by default
 * (`terminalEnabled`); these tests are of the tab itself, so each turns it on through the saved settings (`TERMINAL_ON`).
 * The tab while off is `terminal-off.test.tsx`'s.
 */
const ECHO = "printf 'agent ready\\n'; exec cat";
const INPUT = `label:Terminal input, ${FIRST} on This computer`;

const sentToPanes = () => ["pane.send_input", "pane.send_text", "pane.send_keys"].flatMap((m) => Herdr.testRequests(m));

async function openFirst(program: string | ((app: App) => string) = ECHO): Promise<App> {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  Herdr.testSetProgram(typeof program === "function" ? program(app) : program);
  await openTerminals(app, FIRST);
  await app.waitFor(terminal(FIRST));
  return app;
}

test("Terminal opens the real terminal in place of the chat, after pointing herdr at the pane", async () => {
  const app = await openFirst();
  await app.waitFor("text:agent ready");
  expect(app.shows("label:Message")).toBe(false);
  const [group] = await saved(app);
  expect(group.panels.map((p) => p.split("/")[0])).toEqual(["terminal:local"]);
  expect(nameOf(group.panels[group.active])).toBe(FIRST);
  // The client opens on the session, so the pane is focused first, through the public API.
  expect(Herdr.testRequests("pane.focus").map((r) => (r.params as { pane_id: string }).pane_id)).toContain("w1:p1");
  // and zoomed, so the client shows that pane alone and not herdr's sidebar and the panes beside it
  expect(Herdr.testRequests("pane.zoom")[0]?.params).toEqual({ pane_id: "w1:p1", mode: "on" });
});

test("closing the terminal tab puts the zoom back, because the tab made it", async () => {
  const app = await openFirst();
  await app.waitFor("text:agent ready");
  // A second tab makes the strip show, and its close button is the way to close the first.
  await app.press(sidebarRow(SECOND));
  await settle(app);
  await app.press(`text:${FIRST} (terminal)`);
  await settle(app);
  await app.press(`label:Close tab ${FIRST} (terminal)`);
  await settle(app);
  // Only this pane's: the second agent zooms its own pane.
  const mine = Herdr.testRequests("pane.zoom")
    .map((r) => r.params as { pane_id: string; mode: string })
    .filter((p) => p.pane_id === "w1:p1");
  expect(mine.map((p) => p.mode)).toEqual(["on", "off"]);
});

test("typing reaches the program, and there is no message box, Send or answer dock to type into instead", async () => {
  const app = await openFirst();
  await app.waitFor("text:agent ready");
  // This agent waits on a question: in a chat that would be the answer dock.
  expect(app.shows("label:Answers")).toBe(false);
  expect(app.shows("label:/^Message /")).toBe(false);
  expect(app.shows("Send")).toBe(false);
  await app.type(INPUT, "hello there");
  await app.waitFor("text:hello there");
  // Nothing was sent to the pane by the app: the program is a local process, not herdr's pane.
  expect(sentToPanes()).toEqual([]);
});

test("the hint names the palette chord once, and that chord opens the palette from the terminal without typing into it", async () => {
  const app = await openFirst();
  await app.waitFor("text:agent ready");
  expect(app.texts().filter((t) => t.startsWith("Keys go to the program")).length).toBe(1);
  expect(app.texts().some((t) => t.includes("Ctrl+Shift+L: palette"))).toBe(true);
  await app.keyboard.press("mod+shift+l");
  await settle(app);
  expect(app.shows("label:Search agents, projects and commands")).toBe(true);
  await app.keyboard.press("escape");
  await settle(app);
  // A Ctrl+L or Ctrl+Shift+L that reached the program would be echoed as ^L.
  expect(app.texts().some((t) => t.includes("^L"))).toBe(false);
});

test("a program that ends says so and offers Restart", async () => {
  const app = await openFirst("printf 'bye\\n'; exit 4");
  await app.waitFor("text:The program ended with status 4");
  expect(app.shows("label:Restart")).toBe(true);
  await app.press("label:Restart");
  await app.waitFor("text:bye");
});

test("closing the tab hangs the program up", async () => {
  let marker = "";
  const app = await openFirst(() => {
    marker = `${Files.testTree()}/hung-up`;
    return `trap 'touch ${marker}' HUP; echo up; while :; do sleep 1; done`;
  });
  await app.waitFor("text:up");
  // Ctrl+W is the program's in a terminal (readline's delete-word), so the tab's own close button is the way: a second
  // tab makes the strip show.
  await app.press(sidebarRow(SECOND));
  await settle(app);
  await app.press(`text:${FIRST} (terminal)`);
  await settle(app);
  await app.press(`label:Close tab ${FIRST} (terminal)`);
  await settle(app);
  // The program's trap runs once its children are gone: ask for the marker file until it is there (each ask is a real read,
  // so the loop is bounded by work, not by a duration).
  let hung = false;
  for (let tries = 0; tries < 20_000 && !hung; tries++) {
    hung = await Files.stat("local", marker).then(
      () => true,
      () => false,
    );
  }
  expect(hung).toBe(true);
});

test("a tab restored from the saved layout does not attach by itself: Return reconnects", async () => {
  const layout = {
    center: {
      type: "split",
      axis: "horizontal",
      children: [{ type: "tabs", panels: ["board", "terminal:local/w1:p1"], activeIndex: 1 }],
    },
  };
  const app = await seeded("mixed", { storage: { ...TERMINAL_ON, "herdr.dock.v1": JSON.stringify(layout) } });
  await app.waitFor("label:Board, 2 need you");
  Herdr.testSetProgram(ECHO);
  await app.keyboard.press("mod+shift+]");
  await app.waitFor("text:Press Return to reconnect");
  expect(app.shows("text:agent ready")).toBe(false);
  expect(Herdr.testRequests("pane.focus")).toEqual([]);
  await app.keyboard.press("enter");
  await app.waitFor("text:agent ready");
  expect(Herdr.testRequests("pane.focus").length).toBe(1);
});

test("a chat has the Terminal button, with its key, and the terminal has the way back", async () => {
  const app = await ready(undefined, { storage: TERMINAL_ON });
  Herdr.testSetProgram(ECHO);
  await app.press(sidebarRow(FIRST));
  await settle(app);
  expect(app.shows("label:Show terminal")).toBe(true);
  await app.keyboard.press("mod+shift+m");
  await app.waitFor("text:agent ready");
  expect(app.shows("label:Show chat")).toBe(true);
  await app.keyboard.press("mod+shift+m");
  await app.waitFor("label:Show terminal");
});
