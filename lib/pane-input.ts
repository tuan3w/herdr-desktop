import { announce, Clipboard, signal } from "nsh";

import { fold } from "#lib/text";

/**
 * What the app's global shortcuts and the palette ask of "the tab in front". A `TerminalTab` registers itself while it is
 * `active` (the focused tab of its group), and so does a chat tab, which has a message box and nothing else of these;
 * the functions below act on the newest registration, so two tabs showing at once never both answer a key. With no tab in
 * front, or one without the part asked for, they do nothing.
 */
export interface PaneInput {
  /** Puts the keyboard in the message box (a chat) or in the program (a terminal). */
  focusComposer(): void;
  /** Opens the find bar over the open text (a file viewer; a terminal says its program has its own). */
  searchInPane?(): void;
  /** Copies the last answer of the agent, as Markdown: a chat only. */
  copyReply?(): void;
  /** Copies the code block the person pointed at, else the last one of the last answer: a chat only. */
  copyCode?(): void;
  /** Opens the system's file dialog to attach files to the message: a chat only. */
  attachFiles?(): void;
  /** Quotes `text` in the message box: a chat only. */
  quote?(text: string): void;
  /** Mentions the file or folder `path` of `machine` in the message box and says whether this chat is on that machine: a chat only. */
  mention?(machine: string, path: string): boolean;
}

const registered = signal<readonly PaneInput[]>([]);

/** Makes `pane` the one the functions below act on, until the returned function runs. */
export function registerPane(pane: PaneInput): () => void {
  registered.update((all) => [...all.filter((p) => p !== pane), pane]);
  return () => registered.update((all) => all.filter((p) => p !== pane));
}

const front = (): PaneInput | undefined => registered().at(-1);

/** `Reply…` from the board: the pane was just opened, the keyboard goes to its message box. */
export const focusComposer = (): void => front()?.focusComposer();

/** `mod+f`. */
export const searchInPane = (): void => front()?.searchInPane?.();

/** `mod+shift+y`: the chat in front copies the agent's last answer. */
export const copyReply = (): void => front()?.copyReply?.();

/** `mod+shift+c`: the chat in front copies a code block. */
export const copyCode = (): void => front()?.copyCode?.();

/** `mod+shift+o`: the chat in front opens the file dialog. */
export const attachFiles = (): void => front()?.attachFiles?.();

/**
 * "Send to the agent" from a file viewer: the newest chat tab that can take a mention (not the viewer's own registration,
 * which is newer and has none) mentions `path` (absolute, on `machine`) in its message box, as if it had been picked with
 * `@`. False when no chat is open or the chat runs on another machine.
 */
export const mentionInChat = (machine: string, path: string): boolean =>
  registered()
    .findLast((p) => p.mention !== undefined)
    ?.mention?.(machine, path) ?? false;

/** `mod+shift+q`: the chat in front quotes what the person copied in its message box. */
export async function quoteCopied(): Promise<void> {
  const text = await Clipboard.readText();
  if (text.trim() === "") announce("Nothing is copied. Select text in the conversation and copy it first");
  else front()?.quote?.(text);
}

/** Whether the tab in front is a chat: the palette offers `Copy code` and `Copy last answer` only then. Reactive. */
export const chatInFront = (): boolean => front()?.copyReply !== undefined;

/** Whether a pane is in front: the palette offers pane entries only then. Reactive. */
export const paneInFront = (): boolean => front() !== undefined;

/** The rows that hold `query`, ignoring case, diacritics and invisible characters; none for an empty query (the file viewer's find). */
export function matchRows(rows: readonly string[], query: string): number[] {
  const needle = fold(query.trim());
  if (needle === "") return [];
  const hits: number[] = [];
  rows.forEach((row, i) => {
    if (fold(row).includes(needle)) hits.push(i);
  });
  return hits;
}
