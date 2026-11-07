import { keymap, signal } from "nsh";
import { PaneKeys } from "herdr-desktop/native";
import { fold } from "./text";
import { apple, GLOBAL, keysOf } from "./shortcuts";

/**
 * What the app's global shortcuts and the palette ask of "the tab in front". A `PaneTab` registers itself while it is
 * `active` (the focused tab of its group), and so does a chat tab, which has a message box and nothing else of these;
 * the functions below act on the newest registration, so two tabs showing at once never both answer a key. With no tab in
 * front, or one without the part asked for, they do nothing.
 */
export interface PaneInput {
  /** Puts the keyboard in the message box. */
  focusComposer(): void;
  /** Starts or stops typing into the pane (capture mode): a terminal only. */
  toggleCapture?(): void;
  capturing?(): boolean;
  /** Opens the list of every link in the pane: a terminal only. */
  showLinks?(): void;
  /** Opens the find bar over the pane's text: a terminal only. */
  searchInPane?(): void;
}

/** What a terminal tab registers: every part. */
export type TerminalInput = Required<PaneInput>;

const registered = signal<readonly PaneInput[]>([]);

/** Makes `pane` the one the functions below act on, until the returned function runs. */
export function registerPane(pane: PaneInput): () => void {
  registered.update((all) => [...all.filter((p) => p !== pane), pane]);
  return () => registered.update((all) => all.filter((p) => p !== pane));
}

const front = (): PaneInput | undefined => registered().at(-1);

/** `mod+shift+k`: type into the pane in front, or stop. */
export const toggleCapture = (): void => front()?.toggleCapture?.();

/** Whether the pane in front is being typed into. Reactive. */
export const captureActive = (): boolean => front()?.capturing?.() ?? false;

/** The palette entry `Links in this pane…`. */
export const showLinks = (): void => front()?.showLinks?.();

/** `Reply…` from the board: the pane was just opened, the keyboard goes to its message box. */
export const focusComposer = (): void => front()?.focusComposer();

/** `mod+f`. */
export const searchInPane = (): void => front()?.searchInPane?.();

/** Whether a pane is in front: the palette offers pane entries only then. Reactive. */
export const paneInFront = (): boolean => front() !== undefined;

const NAMED = ["escape", "enter", "tab", "shift+tab", "backspace", "delete", "insert", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

/**
 * The keystrokes capture mode binds, as `keymap` spells them: the keys that are not text (everything else arrives as
 * typed text through the capture field), as herdr names them (`PaneKeys.herdrKey`). Left out:
 * - an app shortcut: on Windows and Linux `mod` is Ctrl, so `ctrl+k` is the palette and stays the app's, everywhere,
 *   capture mode included (that is also how `mod+shift+k` leaves it); on Apple platforms `mod` is Command and every
 *   `ctrl+letter` is the pane's;
 * - `ctrl+v` where Ctrl is `mod`: that is paste, which sends the pasted text (bracketed by the shell) instead;
 * - what the host keeps for itself (`bindable`).
 */
export function captureKeystrokes(onApple: boolean = apple()): string[] {
  const taken = new Set(
    Object.values(GLOBAL).flatMap((shortcut) => keysOf(shortcut, onApple).map((k) => (onApple ? k : k.replace(/^mod\b/, "ctrl")))),
  );
  const candidates = [
    ...NAMED,
    ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
    ...LETTERS.map((l) => `ctrl+${l}`),
    ...LETTERS.map((l) => `alt+${l}`),
  ];
  return candidates.filter((k) => !taken.has(k) && !(!onApple && k === "ctrl+v") && PaneKeys.herdrKey(k) !== null && bindable(k));
}

const probed = new Map<string, boolean>();

/**
 * Whether the host lets the app bind `keystroke`: it keeps some for itself (F11 full screen, Ctrl+Q quit on Windows and
 * Linux) and `keymap.bind` throws for them, which would refuse the whole set. Asked once per key, by binding and
 * releasing it.
 */
function bindable(keystroke: string): boolean {
  let ok = probed.get(keystroke);
  if (ok === undefined) {
    try {
      keymap.bind(keystroke, () => undefined)();
      ok = true;
    } catch {
      ok = false;
    }
    probed.set(keystroke, ok);
  }
  return ok;
}

/** The rows of the pane that hold `query`, ignoring case, diacritics and invisible characters; none for an empty query. */
export function matchRows(rows: readonly string[], query: string): number[] {
  const needle = fold(query.trim());
  if (needle === "") return [];
  const hits: number[] = [];
  rows.forEach((row, i) => {
    if (fold(row).includes(needle)) hits.push(i);
  });
  return hits;
}
