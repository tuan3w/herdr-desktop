import { Herdr } from "herdr-desktop/native";
import { announce, openUrl, signal } from "nsh";

import type { BoardData, BoardRow, PaneMeta } from "herdr-desktop/native";
import type { Accessor } from "nsh";
import type { MenuItem } from "nsh/desktop";

import { compact, confirmDestructive, notify, rail, undoLast } from "#kit";
import { currentCheckout, reviewChanges } from "#lib/changes";
import {
  closeTab,
  focusComposerSoon,
  focused,
  focusedPane,
  groupOf,
  groups,
  lastPane,
  layout,
  focusOtherGroup,
  mergeSplits,
  moveFocused,
  openTerminal,
  openPanel,
  parseTerminalKey,
  parseSessionKey,
  removePanel,
  rowKeyOf,
  selectNth,
  showBoard,
} from "#lib/dock";
import { allRows, board, meta } from "#lib/herdr";
import { back, forward, previousAgent, previousProject, stepProject, switcherKey } from "#lib/nav";
import { canShowChat, openAgent, showChat, showTerminal, TERMINAL_OFF } from "#lib/open-agent";
import { browseFiles } from "#lib/open-files";
import { openPalette, paletteKey } from "#lib/palette/controller";
import {
  attachFiles,
  chatInFront,
  copyCode,
  copyReply,
  focusComposer,
  paneInFront,
  quoteCopied,
  searchInPane,
} from "#lib/pane-input";
import { perfOpen } from "#lib/perf";
import { setSidebarCollapsed, terminalEnabled, themeId } from "#lib/settings";
import { type GlobalShortcut, GLOBAL, keysOf, type ShortcutGroup } from "#lib/shortcuts";
import { splitTab } from "#lib/split";
import { THEMES } from "#lib/theme/themes";

/**
 * Everything the person can do from the keyboard, the palette or the menu, once. `globalActions` has one handler per
 * entry of `GLOBAL` (a shortcut without one does not compile), `actions()` lists them and the extras for the palette,
 * `appMenu()` builds the application menu from the same handlers, and `runAction(id)` runs any of them by id.
 */

/** Which dialogs are open. They live here so a key, a menu item and a palette entry open the same one. */
export { palette } from "#lib/palette/controller";
export const shortcutsOpen = signal(false);

/** The pages of Settings, in the order of its nav. Machines is one of them, not a dialog of its own. */
export type SettingsPage = "look" | "notifications" | "accessibility" | "machines" | "about";

/**
 * The page of Settings while its dialog is open, or `null` while it is closed. A dialog over an unchanged window, by the owner's
 * choice (`design/dialogs.md`): the sidebar's marks stay under the scrim.
 */
export const settingsPage = signal<SettingsPage | null>(null);

export const closeSettings = (): void => settingsPage.set(null);

/** Opens Settings on `page`; without one, on the page that was last in front (Look the first time). */
export function openSettings(page?: SettingsPage): void {
  settingsPage.set(page ?? settingsPage() ?? "look");
}
/** `Start a terminal agent…`: the form that starts an agent in a new herdr tab or workspace. */
export const newAgentOpen = signal(false);
/** `New agent session`: the form that starts a chat with an agent, and the project it was asked from (its machine and folder). */
export const newSessionOpen = signal(false);
export const newSessionProject = signal<{ machine: string; folder: string; worktree?: boolean } | undefined>(undefined);

/**
 * Opens `New agent session`, filled with a project's machine and folder when it was asked from one; `worktree` chooses
 * `New worktree…` as its Checkout once the project's repository is known.
 */
export function newSession(project?: { machine: string; folder: string; worktree?: boolean }): void {
  newSessionProject.set(project);
  newSessionOpen.set(true);
}

/** A name being asked for: a new workspace or tab, or a rename. `components/name-dialog.tsx` shows it. */
export interface NameRequest {
  title: string;
  initial?: string;
  confirm: string;
  onSubmit: (name: string) => void;
}
export const naming = signal<NameRequest | null>(null);

/** The sidebar's search field takes the focus here: a view cannot take it from code, an input can. */
export const sidebarSearch: { focus?: () => void } = {};

export const ACCESSIBILITY_GUIDE = "https://github.com/tuan3w/herdr-desktop/blob/main/docs/ACCESSIBILITY.md";

// ---- what the agents need ----

/**
 * The agents to visit with Next and Previous: those that wait for the person (a chat waiting on a permission or a
 * question included), longest waiting first. One that only finished is not here: it needs a look, not an answer, and
 * the board marks it. An agent on a machine that is not connected is not in it, as it is not in the counts.
 */
export function attentionOrder(data: BoardData): BoardRow[] {
  return data.needsYou.filter((r) => !r.offline);
}

/** The agent after (`1`) or before (`-1`) the one with row key `current` in `order`, wrapping; from outside the list: the first, or the last going back. */
export function stepAttention(order: readonly BoardRow[], current: string | null, step: 1 | -1): BoardRow | undefined {
  if (order.length === 0) return undefined;
  const at = current ? order.findIndex((r) => r.key === current) : -1;
  if (at < 0) return step === 1 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}

/** `mod+j` (`1`) and `mod+shift+j`: opens the next agent that waits. It never answers and takes no focus: the answer dock stands where the message box would. */
export function goAttention(step: 1 | -1): void {
  const row = stepAttention(attentionOrder(board()), rowKeyOf(focused()), step);
  if (!row) {
    announce("Nothing needs you");
    notify("Nothing needs you");
    return;
  }
  void openAgent(row);
  announce(`${row.name}, needs you, ${row.machineName}`);
}

// ---- where a pane lives ----

/** Where panes made here live in herdr: a shell pane is not an agent, so the board has no row for it. */
const made = new Map<string, { workspaceId: string; tabId: string }>();

const metas = new Map<string, Accessor<PaneMeta | null>>();
function paneMeta(machine: string, pane: string): PaneMeta | null {
  const key = `${machine}/${pane}`;
  let one = metas.get(key);
  if (!one) {
    one = meta(machine, pane);
    metas.set(key, one);
  }
  return one();
}

/** The focused pane with what the commands on it need; `null` on the board. */
interface Here {
  machine: string;
  pane: string;
  name: string;
  workspaceId?: string;
  tabId?: string;
  workspaceLabel: string;
  tabLabel: string;
}

function here(): Here | null {
  const at = focusedPane();
  if (!at) return null;
  const row = allRows(board()).find((r) => r.machine === at.machine && r.paneId === at.pane);
  const where = row ?? made.get(`${at.machine}/${at.pane}`);
  const m = paneMeta(at.machine, at.pane);
  return {
    ...at,
    name: m?.name ?? row?.name ?? at.pane,
    workspaceId: where?.workspaceId,
    tabId: where?.tabId,
    workspaceLabel: m?.workspaceLabel ?? "",
    tabLabel: m?.tabLabel ?? "",
  };
}

/** The machine a new workspace goes to: the one the person is working on, else this computer. */
function targetMachine(): string {
  return focusedPane()?.machine ?? Herdr.machines().find((m) => m.enabled)?.id ?? "local";
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function openMade(
  machine: string,
  created: { workspaceId: string; tabId: string; paneId: string },
): Promise<void> {
  made.set(`${machine}/${created.paneId}`, { workspaceId: created.workspaceId, tabId: created.tabId });
  await openTerminal(machine, created.paneId);
}

function fail(what: string, e: unknown): void {
  notify(`${what}: ${message(e)}`, { type: "error" });
}

/** The file browser at the focused pane's folder on its machine; from the board, at this computer's home. */
function browsePaneFiles(): void {
  const at = focusedPane();
  browseFiles(at?.machine ?? "local", (at && paneMeta(at.machine, at.pane)?.cwd) || "~");
}

function newWorkspace(): void {
  const machine = targetMachine();
  naming.set({
    title: "New workspace",
    confirm: "Create",
    onSubmit: (name) => {
      Herdr.createWorkspace(machine, name, null).then(
        (created) => openMade(machine, created),
        (e) => fail("Could not create the workspace", e),
      );
    },
  });
}

function newTab(): void {
  const at = here();
  if (!at?.workspaceId) return;
  const { machine, workspaceId } = at;
  naming.set({
    title: "New tab",
    confirm: "Create",
    onSubmit: (name) => {
      Herdr.createTab(machine, workspaceId!, name, null).then(
        (created) => openMade(machine, created),
        (e) => fail("Could not create the tab", e),
      );
    },
  });
}

function rename(kind: "workspace" | "tab" | "pane"): void {
  const at = here();
  if (!at) return;
  const { machine } = at;
  const initial = kind === "workspace" ? at.workspaceLabel : kind === "tab" ? at.tabLabel : at.name;
  naming.set({
    title: `Rename ${kind}`,
    initial,
    confirm: "Rename",
    onSubmit: (name) => {
      const done =
        kind === "workspace"
          ? Herdr.renameWorkspace(machine, at.workspaceId!, name)
          : kind === "tab"
            ? Herdr.renameTab(machine, at.tabId!, name)
            : Herdr.renamePane(machine, at.pane, name);
      done.then(
        () => announce(`Renamed ${kind}`),
        (e) => fail(`Could not rename the ${kind}`, e),
      );
    },
  });
}

async function splitHerdrPane(direction: "right" | "down"): Promise<void> {
  const at = here();
  if (!at) return;
  try {
    const pane = await Herdr.splitPane(at.machine, at.pane, direction);
    if (at.workspaceId) made.set(`${at.machine}/${pane}`, { workspaceId: at.workspaceId, tabId: at.tabId ?? "" });
    await openTerminal(at.machine, pane);
  } catch (e) {
    fail("Could not split the pane", e);
  }
}

/** What closing in herdr takes with it, said before it happens: these cannot be taken back. */
async function closeInHerdr(kind: "pane" | "tab" | "workspace"): Promise<void> {
  const at = here();
  if (!at) return;
  const label = kind === "pane" ? at.name : kind === "tab" ? at.tabLabel : at.workspaceLabel;
  const taken =
    kind === "pane"
      ? "what runs in it"
      : kind === "tab"
        ? "every pane in it and what runs there"
        : "every tab and pane in it and what runs there";
  const ok = await confirmDestructive({
    title: `Close ${kind} “${label}”?`,
    description: `This stops ${taken}, on ${paneMeta(at.machine, at.pane)?.machineName ?? at.machine}. It cannot be undone.`,
    action: `Close ${kind}`,
  });
  if (!ok) return;
  try {
    if (kind === "pane") await Herdr.closePane(at.machine, at.pane);
    else if (kind === "tab") await Herdr.closeTab(at.machine, at.tabId!);
    else await Herdr.closeWorkspace(at.machine, at.workspaceId!);
    // The tab was the view of what is gone; the other panes of a closed tab or workspace show `Agent gone` until closed.
    removePanel(focused());
    notify(`Closed ${kind} ${label}`);
  } catch (e) {
    fail(`Could not close the ${kind}`, e);
  }
}

// ---- global actions ----

function toggleSidebar(): void {
  const before = rail();
  setSidebarCollapsed(!before);
  // A compact window forces the rail, so the setting then changes nothing anyone sees or hears.
  if (rail() !== before) announce(rail() ? "Sidebar collapsed" : "Sidebar expanded");
}

function focusSidebar(): void {
  // Narrow window: the rail is forced and has no field to take the focus.
  if (rail() && !compact()) setSidebarCollapsed(false);
  if (rail()) {
    announce("The window is too narrow for the sidebar: widen it");
    return;
  }
  // The field exists once the expanded sidebar has rendered.
  setTimeout(() => sidebarSearch.focus?.(), 0);
}

/**
 * `Show chat` / `Show terminal` on the focused tab: the other view of the same terminal agent. With no word asked for (the
 * key) it goes to whichever the tab is not. With the terminal tab off the key does nothing but say so (the shortcuts sheet
 * does not list it then); `Show chat` still swaps a restored terminal tab for its chat.
 */
async function toggleView(which?: "chat" | "terminal"): Promise<void> {
  if (which !== "chat" && !terminalEnabled()) {
    announce(TERMINAL_OFF);
    return;
  }
  const pane = parseTerminalKey(focused());
  const chat = parseSessionKey(focused());
  if (which !== "terminal" && pane) await showChat(pane.machine, pane.pane);
  else if (which !== "chat" && chat?.id.startsWith("pane:"))
    await showTerminal(chat.machine, chat.id.slice("pane:".length));
  else announce(which === "chat" ? "Open a terminal agent first" : "Open a chat read from a terminal first");
}

async function focusPaneArea(): Promise<void> {
  if (focused() === "board" || focused() === "") {
    const last = lastPane();
    if (!last) {
      announce("No pane is open");
      return;
    }
    await openPanel(last);
    await focusComposerSoon();
    return;
  }
  focusComposer();
}

/** One handler per global shortcut; `App.tsx` binds every key of `GLOBAL` to these. */
export const globalActions: Record<GlobalShortcut, () => void> = {
  palette: paletteKey,
  terminalView: () => void toggleView(),
  quickOpen: () => openPalette("files"),
  switcher: () => switcherKey(1),
  switcherBack: () => switcherKey(-1),
  previousAgent,
  previousProject,
  back: () => void back(),
  forward: () => void forward(),
  prevProject: () => stepProject(-1),
  nextProject: () => stepProject(1),
  undo: () => undoLast(),
  nextAttention: () => goAttention(1),
  prevAttention: () => goAttention(-1),
  board: () => void showBoard(),
  changes: () => void reviewChanges(),
  focusPane: () => void focusPaneArea(),
  focusSidebar: focusSidebar,
  sidebar: toggleSidebar,
  tab1: () => selectNth(1),
  tab2: () => selectNth(2),
  tab3: () => selectNth(3),
  tab4: () => selectNth(4),
  tab5: () => selectNth(5),
  tab6: () => selectNth(6),
  tab7: () => selectNth(7),
  tab8: () => selectNth(8),
  tab9: () => selectNth(9),
  closeTab: () => closeTab(focused()),
  splitRight: () => void splitTab(focused(), "right"),
  splitDown: () => void splitTab(focused(), "bottom"),
  copyCode: () => (chatInFront() ? copyCode() : announce("Open a chat first")),
  copyReply: () => (chatInFront() ? copyReply() : announce("Open a chat first")),
  attachFiles: () => (chatInFront() ? attachFiles() : announce("Open a chat first")),
  quoteCopied: () => (chatInFront() ? void quoteCopied() : announce("Open a chat first")),
  search: () => (paneInFront() ? searchInPane() : announce("Open a pane first")),
  newAgent: () => newSession(),
  settings: () => openSettings(),
  shortcuts: () => shortcutsOpen.update((open) => !open),
  devPanel: () => perfOpen.update((open) => !open),
};

/** Commands that have no shortcut of their own, by palette id. */
const extra: Record<string, () => void> = {
  newWorkspace,
  newTab,
  renameWorkspace: () => rename("workspace"),
  renameTab: () => rename("tab"),
  renamePane: () => rename("pane"),
  splitHerdrRight: () => void splitHerdrPane("right"),
  splitHerdrDown: () => void splitHerdrPane("down"),
  closePane: () => void closeInHerdr("pane"),
  closeHerdrTab: () => void closeInHerdr("tab"),
  closeWorkspace: () => void closeInHerdr("workspace"),
  machines: () => openSettings("machines"),
  startTerminalAgent: () => newAgentOpen.set(true),
  showChat: () => void toggleView("chat"),
  showTerminal: () => void toggleView("terminal"),
  browseFiles: browsePaneFiles,
  moveRight: () => void moveFocused("right"),
  moveDown: () => void moveFocused("bottom"),
  moveLeft: () => void moveFocused("left"),
  moveUp: () => void moveFocused("top"),
  moveOther: () => void moveFocused("other"),
  focusOther: () => void focusOtherGroup(),
  mergeSplits: () => void mergeSplits(),
  accessibilityGuide: () => void openUrl(ACCESSIBILITY_GUIDE),
};

/** Runs a command by the id `actions()` gave it (a palette choice, a menu item). A theme is `theme:<id>`, a tab `tab:<key>`. */
export function runAction(id: string): void {
  if (id.startsWith("theme:")) {
    themeId.set(id.slice("theme:".length));
    return;
  }
  if (id.startsWith("tab:")) {
    void openPanel(id.slice("tab:".length));
    return;
  }
  const run = (globalActions as Record<string, (() => void) | undefined>)[id] ?? extra[id];
  run?.();
}

// ---- the list ----

export interface Action {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  keywords?: string[];
}

function shortcutOf(id: GlobalShortcut): string {
  return keysOf(GLOBAL[id])[0];
}

/**
 * The palette's list now: disabled where it cannot apply (a pane command on the board), so the person learns it exists
 * and why not from its dimmed row, and tabs only as far as the focused group has them.
 */
export function actions(): Action[] {
  const at = here();
  const pane = at !== null;
  const group = groupOf(layout(), focused());
  const sideBySide = groups(layout()).length > 1;
  const canMove = sideBySide || (group !== undefined && group.panels.length > 1);
  const list: Action[] = [];
  const global = (id: GlobalShortcut, extraWords: string[] = [], disabled = false) =>
    list.push({
      id,
      label: GLOBAL[id].label,
      group: groupName(GLOBAL[id].group),
      shortcut: shortcutOf(id),
      disabled,
      keywords: extraWords,
    });

  global("nextAttention", ["attention", "blocked", "waiting"]);
  global("prevAttention", ["attention", "blocked", "waiting"]);
  global("board", ["home", "agents"]);
  global("changes", ["diff", "files", "git", "review", "modified", "edits"], currentCheckout() === null);
  global("switcher", ["recent", "switch", "agents", "projects", "mru"]);
  global("quickOpen", ["file", "find file", "open file", "go to file"]);
  global("previousAgent", ["toggle", "last", "alt tab", "swap"]);
  global("previousProject", ["toggle", "last", "swap"]);
  global("prevProject", ["switch"]);
  global("nextProject", ["switch"]);
  global("back", ["history", "previous"]);
  global("forward", ["history", "next"]);
  global("newAgent", ["start", "session"]);
  global("settings", ["preferences", "options"]);
  global("shortcuts", ["keys", "keyboard", "help"]);
  global("sidebar", ["hide", "show"]);
  global("focusSidebar", ["search agents"]);
  global("focusPane", ["composer", "reply"], !pane && !lastPane());
  global("search", ["find"], !pane);
  global("copyCode", ["code block", "clipboard", "snippet"], !chatInFront());
  global("copyReply", ["answer", "message", "clipboard", "markdown"], !chatInFront());
  global("attachFiles", ["file", "picture", "image", "photo", "upload"], !chatInFront());
  global("quoteCopied", ["quote", "reply", "blockquote"], !chatInFront());
  global("closeTab", ["view"], focused() === "board" || focused() === "");
  global(
    "splitRight",
    ["split", "side by side", "companion", "changes", "next to"],
    focused() === "board" || focused() === "",
  );
  global("splitDown", ["split", "below", "companion", "changes"], focused() === "board" || focused() === "");
  global("devPanel", ["performance", "frame"]);
  global("undo");
  const terminal = parseTerminalKey(focused());
  const showableChat = terminal !== null && canShowChat(terminal.machine, terminal.pane);
  const terminalChat = parseSessionKey(focused())?.id.startsWith("pane:") === true;
  list.push({
    id: "showChat",
    label: "Show chat",
    group: "Pane",
    disabled: !showableChat,
    keywords: ["conversation", "transcript"],
  });
  // Off, nothing offers the terminal (`terminalEnabled`): not even a dimmed row.
  if (terminalEnabled())
    list.push({
      id: "showTerminal",
      label: "Show terminal",
      group: "Pane",
      disabled: !terminalChat,
      keywords: ["mirror", "pane"],
    });
  list.push({
    id: "browseFiles",
    label: pane ? "Browse files in this pane's folder…" : "Browse files on this computer…",
    group: pane ? "Pane" : "App",
    keywords: ["folder", "open", "view", "photos", "images"],
  });

  list.push({
    id: "startTerminalAgent",
    label: "Start a terminal agent…",
    group: "herdr",
    keywords: ["new agent", "claude", "codex", "omp"],
  });
  list.push({ id: "newWorkspace", label: "New workspace…", group: "herdr" });
  list.push({ id: "newTab", label: "New tab in this workspace…", group: "herdr", disabled: !at?.workspaceId });
  list.push({ id: "renameWorkspace", label: "Rename workspace…", group: "herdr", disabled: !at?.workspaceId });
  list.push({ id: "renameTab", label: "Rename tab…", group: "herdr", disabled: !at?.tabId });
  list.push({ id: "renamePane", label: "Rename pane…", group: "herdr", disabled: !pane });
  list.push({
    id: "splitHerdrRight",
    label: "Split pane right in herdr",
    group: "herdr",
    disabled: !pane,
    keywords: ["new terminal"],
  });
  list.push({
    id: "splitHerdrDown",
    label: "Split pane down in herdr",
    group: "herdr",
    disabled: !pane,
    keywords: ["new terminal"],
  });
  list.push({
    id: "closePane",
    label: "Close pane in herdr…",
    group: "herdr",
    disabled: !pane,
    keywords: ["stop", "kill"],
  });
  list.push({
    id: "closeHerdrTab",
    label: "Close tab in herdr…",
    group: "herdr",
    disabled: !at?.tabId,
    keywords: ["stop", "kill"],
  });
  list.push({
    id: "closeWorkspace",
    label: "Close workspace in herdr…",
    group: "herdr",
    disabled: !at?.workspaceId,
    keywords: ["stop", "kill"],
  });
  list.push({ id: "machines", label: "Machines…", group: "App", keywords: ["ssh", "connect", "computer"] });

  list.push({ id: "moveRight", label: "Move tab to split right", group: "Tabs", disabled: !canMove });
  list.push({ id: "moveDown", label: "Move tab to split down", group: "Tabs", disabled: !canMove });
  list.push({ id: "moveLeft", label: "Move tab to split left", group: "Tabs", disabled: !canMove });
  list.push({ id: "moveUp", label: "Move tab to split up", group: "Tabs", disabled: !canMove });
  list.push({ id: "moveOther", label: "Move tab to other group", group: "Tabs", disabled: !sideBySide });
  list.push({
    id: "focusOther",
    label: "Focus the other group",
    group: "Tabs",
    disabled: !sideBySide,
    keywords: ["split", "switch"],
  });
  list.push({
    id: "mergeSplits",
    label: "Merge splits",
    group: "Tabs",
    disabled: !sideBySide,
    keywords: ["close split", "one group"],
  });
  if (group) {
    group.panels.slice(0, 9).forEach((key, i) =>
      list.push({
        id: `tab:${key}`,
        label: `Open tab ${i + 1}: ${tabName(key)}`,
        group: "Tabs",
        checked: key === focused(),
      }),
    );
  }

  for (const theme of THEMES)
    list.push({
      id: `theme:${theme.id}`,
      label: `Theme: ${theme.name}`,
      group: "Look",
      checked: themeId() === theme.id,
    });
  list.push({ id: "accessibilityGuide", label: "Accessibility guide", group: "App" });
  return list;
}

/** The palette's heading for a shortcut group of `lib/shortcuts.ts`. */
function groupName(group: ShortcutGroup): string {
  return group === "attention" || group === "navigate"
    ? "Go"
    : group === "tabs"
      ? "Tabs"
      : group === "typing"
        ? "Pane"
        : group === "chat"
          ? "Chat"
          : "App";
}

/** A tab's name for the palette: the agent's name, else `Board`. */
function tabName(key: string): string {
  if (key === "board") return "Board";
  const pane = parseTerminalKey(key);
  if (pane) return paneMeta(pane.machine, pane.pane)?.name ?? pane.pane;
  const rowKey = rowKeyOf(key);
  return allRows(board()).find((r) => r.key === rowKey)?.name ?? "Chat";
}

// ---- the application menu ----

/** The application menu, built from the same handlers; its shortcuts mirror `GLOBAL` (a binding of the keymap wins over a menu item of the same key). */
export function appMenu(): MenuItem[] {
  const item = (label: string, id: GlobalShortcut): MenuItem => ({
    label,
    shortcut: shortcutOf(id),
    onSelect: globalActions[id],
  });
  const plain = (label: string, id: string): MenuItem => ({ label, onSelect: () => runAction(id) });
  return [
    {
      label: "File",
      submenu: [
        item("New agent session", "newAgent"),
        plain("Start a terminal agent…", "startTerminalAgent"),
        plain("New workspace…", "newWorkspace"),
        plain("Machines…", "machines"),
        item("Settings", "settings"),
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        item("Board", "board"),
        item("Sidebar", "sidebar"),
        item("Command palette", "palette"),
        { type: "separator" },
        { role: "zoom" },
        { role: "toggleFullScreen" },
      ],
    },
    {
      label: "Go",
      submenu: [
        item("Next agent that needs you", "nextAttention"),
        item("Previous agent that needs you", "prevAttention"),
        { type: "separator" },
        item("Review changes", "changes"),
        { type: "separator" },
        item("Switch between recent agents and projects", "switcher"),
        item("Previous agent", "previousAgent"),
        item("Previous project", "previousProject"),
        item("Next project", "nextProject"),
        item("Back", "back"),
        item("Forward", "forward"),
        { type: "separator" },
        item("Open pane area", "focusPane"),
        item("Focus the sidebar", "focusSidebar"),
      ],
    },
    {
      label: "Help",
      submenu: [item("Keyboard shortcuts", "shortcuts"), plain("Accessibility guide", "accessibilityGuide")],
    },
  ];
}
