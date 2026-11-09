import { Herdr } from "herdr-desktop/native";
import { expect, test } from "nsh/test";

import type { App } from "nsh/test";

import { type GlobalShortcut, GLOBAL, keysOf } from "#lib/shortcuts";

import {
  DONE,
  FIRST,
  front,
  onBoard,
  openAgents,
  ready,
  saved,
  pressSettled,
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

test("the app opens on the board, with every agent in its table and the count where you look first", async () => {
  const app = await ready();
  expect(onBoard(app)).toBe(true);
  // The board is the overview: its table lists every agent, once (the sidebar is the rail beside it).
  expect(app.shows(sidebarRow(FIRST))).toBe(true);
  expect(app.shows(sidebarRow(DONE))).toBe(true);
  expect(app.count(`label:/^${FIRST}, /`)).toBe(1);
  expect(app.count("role:tab")).toBe(0);
});

test("the board shows the sidebar as the rail, still naming what needs you, and an agent in front brings the full sidebar", async () => {
  const app = await ready();
  expect(app.shows("label:Expand sidebar")).toBe(true);
  expect(app.shows("label:Search projects and agents")).toBe(false);
  expect(app.shows("label:Board, 2 need you")).toBe(true);
  expect(app.shows("label:/^payments, This computer, 2 need you/")).toBe(true);
  await app.press(sidebarRow(FIRST));
  await app.waitFor("label:Search projects and agents");
  expect(app.shows("label:Collapse sidebar")).toBe(true);
  expect(onBoard(app)).toBe(false);
  // Back to the overview: the rail again.
  await app.press("label:Board, 2 need you");
  await app.waitFor("label:Expand sidebar");
  expect(app.shows("label:Search projects and agents")).toBe(false);
});

test("Settings is a dialog over an unchanged window: a waiting question stays marked in the sidebar, the workspace stays mounted, and closing returns to the open agent", async () => {
  const app = await ready();
  await app.press(sidebarRow(FIRST));
  await app.waitFor("label:Search projects and agents");
  await pressSettled(app, "label:Settings", "label:Settings sections");
  expect(app.shows("label:Board, 2 need you")).toBe(true);
  expect(app.shows("label:/^payments, This computer, 2 need you/")).toBe(true);
  // the workspace is not hidden or replaced: the same tab (its header's Open beside) is still there behind the dialog
  expect(app.shows("label:Open beside")).toBe(true);
  await pressSettled(app, "label:Close settings", () => !app.shows("label:Settings sections"));
  expect(await front(app)).toBe(FIRST);
  expect(app.shows("label:Open beside")).toBe(true);
  // Escape closes it too, and nothing was answered by opening or closing it
  await pressSettled(app, "label:Settings", "label:Settings sections");
  await app.keyboard.press("escape");
  await app.waitFor("label:Settings sections", { state: "gone" });
  expect(await front(app)).toBe(FIRST);
});

test("the toggle expands the sidebar for the visit on the board without changing the saved preference", async () => {
  const app = await ready();
  await pressSettled(app, "label:Expand sidebar", "label:Search projects and agents");
  expect(onBoard(app)).toBe(true);
  await settle(app);
  expect(JSON.parse(app.storage()["herdr.settings.v1"] ?? "{}").sidebarCollapsed ?? false).toBe(false);
  // The choice holds for that visit only: an agent and back to the board gives the rail again.
  await app.press(sidebarRow(FIRST));
  await app.waitFor("label:Collapse sidebar");
  await app.press("label:Board, 2 need you");
  await app.waitFor("label:Expand sidebar");
  expect(app.shows("label:Search projects and agents")).toBe(false);
  // Elsewhere the toggle is the saved preference, and the board then keeps the rail.
  await app.press(sidebarRow(FIRST));
  await app.waitFor("label:Collapse sidebar");
  await pressSettled(app, "label:Collapse sidebar", "label:Expand sidebar");
  await settle(app);
  expect(JSON.parse(app.storage()["herdr.settings.v1"]).sidebarCollapsed).toBe(true);
});

test("a rail tile opens its project's agents, and pressing one opens that agent with the full sidebar", async () => {
  const app = await ready();
  // The rail is left of the board, so its tile is the first view of that name.
  await app.press("label:/^payments, This computer, 2 need you/ >> nth=0");
  // `Show project` exists only in the tile's popover.
  await app.waitFor("label:Show payments");
  await app.press("label:/^payments review, claude, needs you, payments/ >> nth=0");
  await app.waitFor("label:Search projects and agents");
  expect(onBoard(app)).toBe(false);
  expect(app.shows("label:Collapse sidebar")).toBe(true);
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

/**
 * Whether a view of `panel`'s kind is the one on screen (which agent it is, is the saved layout's): a chat has its header (its
 * title is the session's, not always the agent's name); a terminal tab (an agent with no chat yet, with the terminal tab off
 * by default) says how to open it in your terminal and has no chat header.
 */
const displayed = (app: App, panel: string): boolean =>
  panel.startsWith("terminal:")
    ? (app.shows("text:This agent has no chat here. Open it in your terminal:") ||
        app.shows("text:The terminal tab is off. Read this agent as a chat, or open it in your terminal:")) &&
      !app.shows("label:/, session details$/")
    : app.count("label:/, session details$/") === 1;

/** The tab group that has the agents' tabs, and which of its panels the key `n` should show. */
async function tabNth(app: App, press: Press, n: number) {
  await openAgents(app, FIRST, SECOND, DONE);
  const [group] = await saved(app);
  const before = group.active;
  await press();
  await settle(app);
  const [after] = await saved(app);
  // A tab that is not there changes nothing; one that is becomes the displayed tab.
  expect(after.active).toBe(n <= group.panels.length ? n - 1 : before);
  const panel = group.panels[after.active];
  expect(panel === "board" ? onBoard(app) : displayed(app, panel)).toBe(true);
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
  // The terminal tab is off by default: the key only says so and opens nothing (on the board there is nothing to swap anyway).
  terminalView: async (app, press) => {
    const tabs = app.count("role:tab");
    await press();
    await settle(app);
    expect(onBoard(app)).toBe(true);
    expect(app.count("role:tab")).toBe(tabs);
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
    // The folder list opens with the field: the first Escape closes it, the second is the dialog's.
    await app.keyboard.press("escape");
    await settle(app);
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
    // The app starts on the Board, where the sidebar is the rail.
    expect(app.shows("label:Search projects and agents")).toBe(false);
    await press();
    expect(app.shows("label:Search projects and agents")).toBe(true);
    await press();
    expect(app.shows("label:Search projects and agents")).toBe(false);
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
    await openAgents(app, FIRST);
    expect(onBoard(app)).toBe(false);
    await press();
    await settle(app);
    expect(onBoard(app)).toBe(true);
  },
  focusPane: async (app, press) => {
    // From the board, the pane used last comes back; here it is a chat (a terminal has no answer dock, `design/chat.md`).
    await openAgents(app, FIRST);
    // The board check left this agent's tab open, and a tab reopens on the view it was left on.
    await app.waitUntil(() => app.shows("label:Answer") || app.shows("label:Show chat"));
    if (!app.shows("label:Answer")) await pressSettled(app, "label:Show chat", "label:Answer");
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
  // An agent is in front: a terminal's search is the program's own (`components/terminal-tab.tsx`) and a chat has no find
  // bar, so the key opens none over it. The find bar of a file is `components/files.test.tsx`'s.
  search: async (app, press) => {
    await press();
    expect(app.shows("label:Close find")).toBe(false);
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
  "terminalView",
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
  // The headless harness has no Tab traversal, so the one pointer step is the row itself; the digits that answer from
  // the keyboard once an answer has the focus are tested with the dock (`answer-dock.test.tsx`).
  await app.press("label:1. Yes");
  await app.waitFor("Sent: 1. Yes");
  expect(sentKeys()).toEqual(["w1:p1: 1 enter"]);
  // The terminal tab is off by default, so the chat offers no way into a terminal (`terminal-tab.test.tsx` has it on).
  expect(app.shows("label:Show terminal")).toBe(false);
});

test("no bar sits under the workspace on the board or in a chat that reports no context, and no machine count sits at the window's bottom", async () => {
  const app = await ready();
  expect(app.shows("label:Status")).toBe(false);
  expect(app.shows("1 machine")).toBe(false);
  await openAgents(app, FIRST);
  expect(app.shows("label:Status")).toBe(false);
});

/** Runs a palette command by its name: `mod+p`, a search, the row. */
async function runCommand(app: App, name: string) {
  await app.keyboard.press("mod+p");
  await settle(app);
  await app.clear("label:Search agents, projects and commands");
  await app.type("label:Search agents, projects and commands", name.replace("…", ""));
  await settle(app);
  await app.press(`label:/^${name}/`);
  await settle(app);
}

test("installing herdr's hook changes another program's settings, so it asks first and only a confirmed one reaches herdr", async () => {
  const app = await ready();
  app.onDialog(() => "Cancel");
  await runCommand(app, "Install herdr hook for Claude Code…");
  expect(Herdr.testRequests("integration.install")).toEqual([]);

  app.onDialog(() => "Install hook");
  await runCommand(app, "Install herdr hook for Claude Code…");
  await app.waitUntil(() => Herdr.testRequests("integration.install").length === 1);
  expect(Herdr.testRequests("integration.install")[0].params).toEqual({ target: "claude" });
  // It says where, and that the agent must be restarted, with what herdr added.
  await app.waitUntil(() => app.texts().some((t) => t.includes("Installed on This computer. Restart the agent")));
});
