import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import { type GlobalShortcut, GLOBAL, keysOf } from "#lib/shortcuts";

import {
  DONE,
  FIRST,
  front,
  nameOf,
  onBoard,
  openAgents,
  openTerminals,
  ready,
  saved,
  seeded,
  SECOND,
  settle,
  shown,
  sidebarRow,
  WEB,
} from "./app-seam";
import { sentKeys } from "./components/board-seam";

/**
 * The whole app against the scripted herdr's `mixed` fixture: 2 agents that need you (`payments review`, `auth`), 1 to
 * review (`Fix login flow`), 2 working, 3 idle, in two projects. Opening an agent puts its tab in the area: the chat of an
 * agent that has one (all of these do), else its terminal. A terminal's mirror is named `Terminal, <agent> on This
 * computer`; which tab is displayed is otherwise read from the saved layout.
 */

test("the app opens on the board, with every agent in the sidebar and the count where you look first", async () => {
  const app = await ready();
  expect(onBoard(app)).toBe(true);
  expect(app.shows(sidebarRow(FIRST))).toBe(true);
  expect(app.shows(sidebarRow(DONE))).toBe(true);
  expect(app.count("role:tab")).toBe(0);
});

test("opening an agent from the sidebar adds its chat tab and shows it; closing the tab leaves the agent running", async () => {
  const app = await ready();
  await openAgents(app, FIRST);
  // The agent is alone in its project: one view, no strip.
  expect(app.count("role:tab")).toBe(0);
  expect(await front(app)).toBe(FIRST);
  expect(shown(app, FIRST)).toBe(false);
  await app.keyboard.press("mod+w");
  await settle(app);
  // The project stays, empty: it shows its own card.
  expect(app.count("role:tab")).toBe(0);
  expect(app.shows("label:payments, no tabs open")).toBe(true);
  expect(app.shows(sidebarRow(FIRST))).toBe(true);
  expect(Herdr.testRequests("pane.close")).toEqual([]);
});

test("the same agent opened twice is one tab", async () => {
  const app = await ready();
  await openAgents(app, FIRST, SECOND, FIRST);
  expect(app.count("role:tab")).toBe(2);
  expect(await front(app)).toBe(FIRST);
});

test("the board cannot be closed: mod+w on it does nothing, and it stays", async () => {
  const app = await ready();
  await app.keyboard.press("mod+w");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
  expect(onBoard(app)).toBe(true);
});

test("Next and Previous walk the agents that wait for you, longest waiting first, and wrap; a finished agent is not on the walk and nothing is ever sent", async () => {
  const app = await ready();
  const step = async (keys: string, name: string) => {
    await app.keyboard.press(keys);
    await settle(app);
    expect(await front(app)).toBe(name);
  };
  await step("mod+j", FIRST);
  await step("mod+j", SECOND);
  await step("mod+j", FIRST);
  await step("mod+shift+j", SECOND);
  await step("mod+shift+j", FIRST);
  expect(sentKeys()).toEqual([]);
});

test("with nothing that needs you, Next opens nothing and says so", async () => {
  const app = await seeded("empty");
  await app.waitFor("Add your first machine");
  await app.keyboard.press("mod+j");
  await settle(app);
  expect(app.count("role:tab")).toBe(0);
  expect(app.shows("Nothing needs you")).toBe(true);
});

/** What each global shortcut does, checked from a state the check sets up. `press` presses the key under test, or another shortcut's first key. */
type Press = (other?: GlobalShortcut) => Promise<void>;
type Check = (app: App, press: Press) => Promise<void>;

/** The tab group that has the agents' tabs, and which of its panels the key `n` should show. */
async function tabNth(app: App, press: Press, n: number) {
  await openTerminals(app, FIRST, SECOND, DONE);
  const [group] = await saved(app);
  const before = group.active;
  await press();
  await settle(app);
  const [after] = await saved(app);
  // A tab that is not there changes nothing; one that is becomes the displayed tab.
  expect(after.active).toBe(n <= group.panels.length ? n - 1 : before);
  const panel = group.panels[after.active];
  expect(panel === "board" ? onBoard(app) : shown(app, nameOf(panel))).toBe(true);
}

/** The Switcher's filter field. The headless harness does not move the keyboard into a dialog that opens over a focused tab, so a test that presses Escape or Enter there focuses the field first, as the person's first keystroke does. */
const FILTER = "label:Filter recent agents and projects";

/** The Switcher's place in its list (`2 of 5`), `undefined` while it is closed. */
const position = (app: App): string | undefined => app.texts().find((t) => /^\d+ of \d+$/.test(t));

const CHECKS: Record<GlobalShortcut, Check> = {
  palette: async (app, press) => {
    await press();
    expect(app.shows("label:Search agents, projects and commands")).toBe(true);
    await app.keyboard.press("escape");
    expect(app.shows("label:Search agents, projects and commands")).toBe(false);
  },
  quickOpen: async (app, press) => {
    await press();
    expect(app.shows("label:Search files of this project")).toBe(true);
    await app.keyboard.press("escape");
    expect(app.shows("label:Search files of this project")).toBe(false);
  },
  shortcuts: async (app, press) => {
    await press();
    expect(app.shows("Keyboard shortcuts")).toBe(true);
    await app.keyboard.press("escape");
    expect(app.shows("Keyboard shortcuts")).toBe(false);
  },
  settings: async (app, press) => {
    await press();
    expect(app.shows("label:Theme")).toBe(true);
    await app.keyboard.press("escape");
    await settle(app);
    expect(app.shows("label:Theme")).toBe(false);
  },
  newAgent: async (app, press) => {
    await press();
    expect(app.shows("label:Folder *")).toBe(true);
    await app.keyboard.press("escape");
    await settle(app);
    expect(app.shows("label:Folder *")).toBe(false);
  },
  devPanel: async (app, press) => {
    await press();
    expect(app.shows("label:Close dev panel")).toBe(true);
    await press();
    expect(app.shows("label:Close dev panel")).toBe(false);
  },
  sidebar: async (app, press) => {
    expect(app.shows("label:Search projects")).toBe(true);
    await press();
    expect(app.shows("label:Search projects")).toBe(false);
    await press();
    expect(app.shows("label:Search projects")).toBe(true);
  },
  focusSidebar: async (app, press) => {
    await press();
    await app.clock!.runFor(50);
    // The keyboard is in the search field now: letters land there.
    for (const letter of "au") await app.keyboard.press(letter);
    expect(app.value("label:Search projects")).toBe("au");
    await app.clear("label:Search projects");
  },
  board: async (app, press) => {
    await openTerminals(app, FIRST);
    expect(onBoard(app)).toBe(false);
    await press();
    await settle(app);
    expect(onBoard(app)).toBe(true);
  },
  focusPane: async (app, press) => {
    // From the board, the pane used last comes back.
    await press("board");
    await settle(app);
    expect(onBoard(app)).toBe(true);
    await press();
    await settle(app);
    expect(onBoard(app)).toBe(false);
    // That pane asks a question, so the answers stand where its message box would be: there is no box to hold the keyboard.
    expect(app.shows("label:Answer")).toBe(true);
    expect(app.shows("label:/^Message /")).toBe(false);
  },
  nextAttention: async (app, press) => {
    await press("board");
    await press();
    await settle(app);
    expect(await front(app)).toBe(FIRST);
  },
  prevAttention: async (app, press) => {
    await press();
    await settle(app);
    // Previous from the first agent that waits wraps to the last one that waits: a finished agent is not on the walk.
    expect(await front(app)).toBe(SECOND);
  },
  switcher: async (app, press) => {
    await openAgents(app, FIRST, SECOND);
    await press();
    expect(app.shows("Switch to…")).toBe(true);
    // The first row is where you are, the highlight starts on the way back.
    await app.clock!.runFor(50);
    expect(position(app)).toMatch(/^2 of /);
    await press();
    // Two agents are open: the second press goes past the last row and wraps to the first.
    expect(position(app)).toMatch(/^1 of 2/);
    await app.clear(FILTER);
    await app.keyboard.press("escape");
    await settle(app);
    expect(app.shows("Switch to…")).toBe(false);
    expect(await front(app)).toBe(SECOND);
  },
  switcherBack: async (app, press) => {
    await press();
    expect(app.shows("Switch to…")).toBe(true);
    await app.clock!.runFor(50);
    // Going up from nothing starts at the bottom of the list.
    const [at, of] = position(app)!.split(" of ");
    expect(at).toBe(of);
    await app.clear(FILTER);
    await app.keyboard.press("escape");
    await settle(app);
    expect(app.shows("Switch to…")).toBe(false);
  },
  previousAgent: async (app, press) => {
    await openAgents(app, FIRST, SECOND);
    await press();
    await settle(app);
    expect(await front(app)).toBe(FIRST);
    await press();
    await settle(app);
    expect(await front(app)).toBe(SECOND);
  },
  previousProject: async (app, press) => {
    await openAgents(app, FIRST, WEB);
    await press();
    await settle(app);
    expect(await front(app)).toBe(FIRST);
    await press();
    await settle(app);
    expect(await front(app)).toBe(WEB);
  },
  back: async (app, press) => {
    await openAgents(app, FIRST, SECOND);
    await press();
    await settle(app);
    expect(await front(app)).toBe(FIRST);
  },
  forward: async (app, press) => {
    await openAgents(app, FIRST, SECOND);
    await press("back");
    await settle(app);
    await press();
    await settle(app);
    expect(await front(app)).toBe(SECOND);
  },
  prevProject: async (app, press) => {
    await openAgents(app, FIRST);
    await press();
    await settle(app);
    // Two projects: going back from the first wraps to the last, which is `web`.
    expect([FIRST, SECOND, DONE, "Refactor ledger", "upgrade deps"]).not.toContain(await front(app));
  },
  nextProject: async (app, press) => {
    await openAgents(app, WEB);
    await press();
    await settle(app);
    expect([WEB, "notes", "scripts"]).not.toContain(await front(app));
  },
  tab1: (app, press) => tabNth(app, press, 1),
  tab2: (app, press) => tabNth(app, press, 2),
  tab3: (app, press) => tabNth(app, press, 3),
  tab4: (app, press) => tabNth(app, press, 4),
  tab5: (app, press) => tabNth(app, press, 5),
  tab6: (app, press) => tabNth(app, press, 6),
  tab7: (app, press) => tabNth(app, press, 7),
  tab8: (app, press) => tabNth(app, press, 8),
  tab9: (app, press) => tabNth(app, press, 9),
  // They act on a chat (`session-tab.test.tsx` copies from one); with a terminal in front they copy nothing and say so.
  copyCode: async (app, press) => {
    await press();
    expect(app.clipboard() ?? "").toBe("");
  },
  copyReply: async (app, press) => {
    await press();
    expect(app.clipboard() ?? "").toBe("");
  },
  // Outside a chat both say so and do nothing: the file dialog needs a message box to attach to.
  attachFiles: async (app, press) => {
    await press();
    expect(app.shows("label:Message")).toBe(false);
  },
  quoteCopied: async (app, press) => {
    await press();
    expect(app.shows("label:Message")).toBe(false);
  },
  search: async (app, press) => {
    await press();
    expect(app.shows("label:Find in the pane >> nth=0")).toBe(true);
    await app.press("label:Close find");
  },
  undo: async (app, press) => {
    await press("board");
    await settle(app);
    await app.press(`label:Reviewed: ${DONE}`);
    await app.waitFor("Marked reviewed");
    await app.waitFor(`label:Reviewed: ${DONE}`, { state: "gone" });
    await press();
    await app.waitFor(`label:Reviewed: ${DONE}`);
  },
  splitRight: async (app, press) => {
    await openAgents(app, FIRST, SECOND);
    const before = (await saved(app)).length;
    await press();
    expect((await saved(app)).length).toBe(before + 1);
  },
  splitDown: async (app, press) => {
    await openAgents(app, DONE);
    const before = (await saved(app)).length;
    await press();
    expect((await saved(app)).length).toBe(before + 1);
  },
  closeTab: async (app, press) => {
    await openAgents(app, "Refactor ledger");
    const before = app.count("role:tab");
    await press();
    await settle(app);
    expect(app.count("role:tab")).toBe(before - 1);
  },
  changes: async (app, press) => {
    await openAgents(app, "Refactor ledger");
    const before = app.count("role:tab");
    await press();
    await settle(app);
    // The agent's folder is not a repository on this machine: the tab opens and says so instead of staying shut.
    await app.waitFor("label:/^Changes in /");
    expect(app.count("role:tab")).toBe(before + 1);
    await app.press("label:/^Close tab Changes/");
    await settle(app);
    expect(app.count("role:tab")).toBe(before);
  },
};

/** The order the checks run in: each starts from what the one before left (tabs open, a pane in front). */
const ORDER: GlobalShortcut[] = [
  "palette",
  "quickOpen",
  "shortcuts",
  "settings",
  "newAgent",
  "devPanel",
  "sidebar",
  // Before any check leaves the keyboard in a text field: there Ctrl+Z undoes the text, as it must, and not the toast.
  "undo",
  "focusSidebar",
  "board",
  "focusPane",
  "nextAttention",
  "prevAttention",
  "switcher",
  "switcherBack",
  "previousAgent",
  "previousProject",
  "back",
  "forward",
  "prevProject",
  "nextProject",
  "copyCode",
  "copyReply",
  "search",
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "tab9",
  "closeTab",
  "splitRight",
  "splitDown",
  "changes",
  "attachFiles",
  "quoteCopied",
];

for (const platform of ["macos", "windows", "linux"] as const) {
  test(`every global shortcut works on ${platform}`, async () => {
    expect([...ORDER].sort()).toEqual(Object.keys(GLOBAL).sort());
    const apple = platform === "macos";
    const app = await ready(platform);
    for (const id of ORDER) {
      // A shortcut with two keys (Help: F1 and Ctrl+/) is checked once per key.
      for (const key of keysOf(GLOBAL[id], apple)) {
        const press: Press = async (other = id) => {
          await app.keyboard.press(other === id ? key : keysOf(GLOBAL[other], apple)[0]);
          await app.clock!.runFor(50);
        };
        await CHECKS[id](app, press);
      }
    }
  });
}

test("walking the app with the keyboard: next agent, type to it, take over its keys, leave, answer", async () => {
  const app = await ready();
  await app.keyboard.press("mod+j");
  await settle(app);
  expect(await front(app)).toBe(FIRST);
  // The agent waits for an answer, so its chat shows the answers where the message box would be. The chat opens when the
  // session's first read arrives (real time, not the manual clock), so wait for the dock. Opening it answers nothing.
  await app.waitFor("label:Answer");
  await settle(app);
  expect(app.shows("label:Message")).toBe(false);
  expect(sentKeys()).toEqual([]);
  // Open pane area (mod+2) has no message box to go to: it puts the keyboard on the first answer and never sends it.
  await app.keyboard.press("mod+2");
  await settle(app);
  expect(app.shows("label:Answer")).toBe(true);
  expect(sentKeys()).toEqual([]);
  // Pressing it again goes to the next agent that waits and still answers nothing; going back returns to the first.
  await app.keyboard.press("mod+j");
  await settle(app);
  expect(await front(app)).toBe(SECOND);
  await app.keyboard.press("mod+shift+j");
  await settle(app);
  expect(await front(app)).toBe(FIRST);
  expect(sentKeys()).toEqual([]);
  // The pane's view is one press away, and has the answers.
  await app.press("Show terminal");
  await settle(app);
  expect(shown(app, FIRST)).toBe(true);

  // The headless harness has no Tab traversal, so the one pointer step is the row itself; the digits that answer from
  // the keyboard once an answer has the focus are tested with the dock (`answer-dock.test.tsx`).
  await app.press("label:1. Yes");
  await app.waitFor("Sent: 1. Yes");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
});

test("no bar sits under the workspace on the board or in a chat that reports no context, and no machine count sits at the window's bottom", async () => {
  const app = await ready();
  expect(app.shows("label:Status")).toBe(false);
  expect(app.shows("1 machine")).toBe(false);
  await openAgents(app, FIRST);
  expect(app.shows("label:Status")).toBe(false);
});
