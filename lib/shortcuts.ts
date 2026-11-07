import { keymap } from "nsh";

/**
 * Every keyboard shortcut of the app, once. `App.tsx` binds the global ones from `GLOBAL` (a missing handler is a type
 * error), `components/shortcuts.tsx` lists all of them (⌘/ or F1, and Settings), and every hint and tooltip names its key through
 * `keyLabel`: a key changed here changes the binding, the hints and the list together.
 *
 * Keys are `keymap` keystrokes. `mod` is Command on Apple platforms and Ctrl on every other, so one string is right on
 * macOS, Windows and Linux; `keymap.label` renders it per platform (`⌘N`, `Ctrl+N`). Rules that keep it so
 * (`shortcuts.test.ts` checks them):
 * - a global shortcut has `mod` (or is a function key): a bare key would steal typing, and input methods (Telex, VNI,
 *   dead keys) type with plain letters;
 * - never `alt`: it is Option on a Mac (⌥P types π) and AltGr on many Windows layouts (Ctrl+Alt types a letter);
 * - the one exception is `ctrl+tab` and `ctrl+shift+tab` (written with `ctrl`, never `mod`): no layout types them and on
 *   Apple platforms `cmd+tab` belongs to the system;
 * - not a key the platform keeps (`keymap.bind` throws on ⌘Q, ⌘H, ⌘M, Ctrl+Q, Alt+F4, F11);
 * - where a platform's habit differs, give that platform its own keys (`apple`, `other`) instead of bending one.
 * Escape is never a global shortcut and never the way out of capture mode: agents need it.
 */
export type ShortcutGroup = "general" | "attention" | "navigate" | "tabs" | "typing" | "chat" | "dev";

export interface Group {
  id: ShortcutGroup;
  title: string;
}

export const GROUPS: Group[] = [
  { id: "general", title: "General" },
  { id: "attention", title: "Needs you" },
  { id: "navigate", title: "Go to" },
  { id: "tabs", title: "Tabs and splits" },
  { id: "typing", title: "Typing and choosing" },
  { id: "chat", title: "In a chat" },
  { id: "dev", title: "Developer tools" },
];

export interface Shortcut {
  /** On every platform, unless `apple` or `other` replaces it. More than one key: any of them does it (shown in order). */
  keys: string[];
  /** Instead of `keys` on Apple platforms (macOS, iOS, a browser on one). */
  apple?: string[];
  /** Instead of `keys` on Windows, Linux and every other platform. */
  other?: string[];
  label: string;
  group: ShortcutGroup;
  /** Fires in a text field too: nsh gives a field the copy and redo chords (`mod+shift+c` among them), and this is not one to lose to the message box. */
  always?: boolean;
}

export type GlobalShortcut =
  | "palette"
  | "quickOpen"
  | "switcher"
  | "switcherBack"
  | "previousAgent"
  | "previousProject"
  | "back"
  | "forward"
  | "prevProject"
  | "nextProject"
  | "undo"
  | "nextAttention"
  | "prevAttention"
  | "board"
  | "changes"
  | "changes"
  | "focusPane"
  | "focusSidebar"
  | "sidebar"
  | "tab1"
  | "tab2"
  | "tab3"
  | "tab4"
  | "tab5"
  | "tab6"
  | "tab7"
  | "tab8"
  | "tab9"
  | "closeTab"
  | "splitRight"
  | "splitDown"
  | "capture"
  | "copyCode"
  | "copyReply"
  | "search"
  | "newAgent"
  | "settings"
  | "shortcuts"
  | "devPanel";

/** Work anywhere in the app, even in a text field (unless the field uses the key itself: undo, paste, caret keys). */
export const GLOBAL: Record<GlobalShortcut, Shortcut> = {
  // `mod+shift+p` is the palette's key while typing into a pane: `mod+k` is then the pane's (`capturedBy`).
  palette: { keys: ["mod+k", "mod+shift+p"], label: "Command palette", group: "general" },
  quickOpen: { keys: ["mod+p"], label: "Find a file in the project", group: "navigate" },
  newAgent: { keys: ["mod+n"], label: "New agent session", group: "general" },
  // The Undo of a toast (`notify(..., { undo })`): the kit names this key in its hint, so it exists even though a text field keeps its own undo.
  undo: { keys: ["mod+z"], label: "Undo the latest change", group: "general" },
  search: { keys: ["mod+f"], label: "Search in the pane or transcript", group: "general" },
  settings: { keys: ["mod+,"], label: "Settings", group: "general" },
  // F1 is Help on Windows and Linux; on a Mac it is brightness unless Fn is held, and ⌘/ is the habit there.
  shortcuts: { keys: ["mod+/"], other: ["f1", "mod+/"], label: "Keyboard shortcuts", group: "general" },
  nextAttention: { keys: ["mod+j"], label: "Next agent that needs you", group: "attention" },
  prevAttention: { keys: ["mod+shift+j"], label: "Previous agent that needs you", group: "attention" },
  // The two taps and the list of places visited last (`lib/nav.ts`). `ctrl+tab` is no key a text field uses, but the
  // keymap counts Tab among them, so it fires in a field only with `always`.
  previousAgent: {
    keys: ["ctrl+tab"],
    label: "Switch to the previous agent",
    group: "navigate",
    always: true,
  },
  previousProject: {
    keys: ["ctrl+shift+tab"],
    label: "Switch to the previous project",
    group: "navigate",
    always: true,
  },
  switcher: { keys: ["mod+e"], label: "Switch between recent agents and projects", group: "navigate" },
  switcherBack: { keys: ["mod+shift+e"], label: "Switcher, going up the list", group: "navigate" },
  back: { keys: ["mod+["], label: "Back to the place you came from", group: "navigate" },
  forward: { keys: ["mod+]"], label: "Forward again", group: "navigate" },
  prevProject: { keys: ["mod+shift+["], label: "Previous project", group: "navigate" },
  nextProject: { keys: ["mod+shift+]"], label: "Next project", group: "navigate" },
  board: { keys: ["mod+1"], label: "Board", group: "navigate" },
  changes: { keys: ["mod+shift+g"], label: "Review changes", group: "navigate" },
  changes: { keys: ["mod+shift+g"], label: "Review changes", group: "navigate" },
  focusPane: { keys: ["mod+2"], label: "Open pane area", group: "navigate" },
  focusSidebar: { keys: ["mod+0"], label: "Sidebar", group: "navigate" },
  sidebar: { keys: ["mod+b"], label: "Show or hide the sidebar", group: "navigate" },
  tab1: { keys: ["mod+shift+1"], label: "Open tab 1", group: "tabs" },
  tab2: { keys: ["mod+shift+2"], label: "Open tab 2", group: "tabs" },
  tab3: { keys: ["mod+shift+3"], label: "Open tab 3", group: "tabs" },
  tab4: { keys: ["mod+shift+4"], label: "Open tab 4", group: "tabs" },
  tab5: { keys: ["mod+shift+5"], label: "Open tab 5", group: "tabs" },
  tab6: { keys: ["mod+shift+6"], label: "Open tab 6", group: "tabs" },
  tab7: { keys: ["mod+shift+7"], label: "Open tab 7", group: "tabs" },
  tab8: { keys: ["mod+shift+8"], label: "Open tab 8", group: "tabs" },
  tab9: { keys: ["mod+shift+9"], label: "Open tab 9", group: "tabs" },
  closeTab: { keys: ["mod+w"], label: "Close tab (the pane keeps running)", group: "tabs" },
  splitRight: { keys: ["mod+\\"], label: "Split right", group: "tabs" },
  splitDown: { keys: ["mod+shift+\\"], label: "Split down", group: "tabs" },
  capture: { keys: ["mod+shift+k"], label: "Type into the pane, or stop typing into it", group: "typing" },
  copyCode: {
    keys: ["mod+shift+c"],
    label: "Copy code (the block under the pointer, else the last one)",
    group: "chat",
    always: true,
  },
  copyReply: { keys: ["mod+shift+y"], label: "Copy the agent's last answer", group: "chat", always: true },
  devPanel: { keys: ["mod+shift+d"], label: "Developer panel (frame time, latency, data)", group: "dev" },
};

/** Work only in one place: a component binds its own, or the control takes them natively. */
export const LOCAL: Shortcut[] = [
  { keys: ["enter"], label: "Send the message, choose the highlighted row", group: "typing" },
  { keys: ["shift+enter"], label: "New line in the message", group: "typing" },
  { keys: ["up", "down"], label: "Move in menus and lists", group: "typing" },
  { keys: ["escape"], label: "Close a dialog, menu or list", group: "typing" },
  { keys: ["tab"], label: "Next scope in the palette", group: "typing" },
];

/** In the order the list shows them: by group, global before local. */
export const SHORTCUTS: Shortcut[] = [...Object.values(GLOBAL), ...LOCAL];

/**
 * Whether this app runs on an Apple platform. Read from `keymap`, which is what decides what `mod` means, so the keys
 * and the hints cannot disagree (also in a test that opens the app as another platform).
 */
export const apple = (): boolean => keymap.label("mod+n").startsWith("⌘");

/** The keys a terminal can send as a control byte: a letter, and `[ ] \\ /` (Escape's byte, SIGQUIT, 0x1d, 0x1f). */
const PANE_CHORD = /^mod\+(?:[a-z]|\[|\]|\\|\/)$/;

/**
 * Who hears `keystroke` while capture mode types into a pane. On Windows and Linux `mod` is Ctrl and a terminal can send
 * every plain Ctrl+letter and Ctrl+`[ ] \\ /`, so those go to the pane (Ctrl+K kills to the end of the line, Ctrl+W a word):
 * the app keeps only what a terminal cannot encode, which is every chord with Shift (Ctrl+Shift+P reads as Ctrl+P on the
 * wire), `ctrl+tab`, `mod+,`, `mod+<digit>` and function keys. Apple platforms are unchanged: `mod` is Command, which a
 * terminal never receives, so every Command chord is the app's and every Ctrl chord the pane's.
 */
export function capturedBy(keystroke: string, onApple: boolean = apple()): "app" | "pane" {
  return !onApple && PANE_CHORD.test(keystroke) ? "pane" : "app";
}

/** The keystrokes of `shortcut` on this platform (or on `onApple` when given, for a test). */
export function keysOf(shortcut: Shortcut, onApple: boolean = apple()): string[] {
  return (onApple ? shortcut.apple : shortcut.other) ?? shortcut.keys;
}

/**
 * One key as the list and the hints write it: `keymap.label`, except Escape, which Apple platforms get as ⎋ (U+238B), a
 * glyph most fonts lack and the system draws as an unrelated arrow.
 */
export function keyText(keystroke: string): string {
  const label = keymap.label(keystroke);
  return label === "⎋" ? "Esc" : label;
}

/** What a hint or tooltip shows for a global shortcut: its first key, as this platform writes it. */
export const keyLabel = (id: GlobalShortcut): string => keyText(keysOf(GLOBAL[id])[0]);
