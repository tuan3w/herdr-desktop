import { signal } from "nsh";

import { fold } from "#lib/text";

/**
 * What the app's global shortcuts and the palette ask of "the tab in front". A `PaneTab` registers itself while it is
 * `active` (the focused tab of its group), and so does a chat tab, which has a message box and nothing else of these;
 * the functions below act on the newest registration, so two tabs showing at once never both answer a key. With no tab in
 * front, or one without the part asked for, they do nothing.
 */
export interface PaneInput {
  /** Puts the keyboard in the message box. */
  focusComposer(): void;
  /** Opens the list of every link in the pane: a terminal only. */
  showLinks?(): void;
  /** Opens the find bar over the pane's text: a terminal only. */
  searchInPane?(): void;
  /** Copies the last answer of the agent, as Markdown: a chat only. */
  copyReply?(): void;
  /** Copies the code block the person pointed at, else the last one of the last answer: a chat only. */
  copyCode?(): void;
}

const registered = signal<readonly PaneInput[]>([]);

/** Makes `pane` the one the functions below act on, until the returned function runs. */
export function registerPane(pane: PaneInput): () => void {
  registered.update((all) => [...all.filter((p) => p !== pane), pane]);
  return () => registered.update((all) => all.filter((p) => p !== pane));
}

const front = (): PaneInput | undefined => registered().at(-1);

/** The palette entry `Links in this pane…`. */
export const showLinks = (): void => front()?.showLinks?.();

/** `Reply…` from the board: the pane was just opened, the keyboard goes to its message box. */
export const focusComposer = (): void => front()?.focusComposer();

/** `mod+f`. */
export const searchInPane = (): void => front()?.searchInPane?.();

/** `mod+shift+y`: the chat in front copies the agent's last answer. */
export const copyReply = (): void => front()?.copyReply?.();

/** `mod+shift+c`: the chat in front copies a code block. */
export const copyCode = (): void => front()?.copyCode?.();

/** Whether the tab in front is a chat: the palette offers `Copy code` and `Copy last answer` only then. Reactive. */
export const chatInFront = (): boolean => front()?.copyReply !== undefined;

/** Whether a pane is in front: the palette offers pane entries only then. Reactive. */
export const paneInFront = (): boolean => front() !== undefined;

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
