import { effect, signal } from "nsh";

/** The open dialogs, bottom first. Pure: the reactive stack below holds one of these. */
export function pushDialog(stack: readonly string[], id: string): string[] {
  return [...stack.filter((d) => d !== id), id];
}

/** `stack` without `id`; the same array when `id` was not in it, so a closed dialog that unmounts changes nothing. */
export function removeDialog(stack: readonly string[], id: string): readonly string[] {
  return stack.includes(id) ? stack.filter((d) => d !== id) : stack;
}

const open = signal<readonly string[]>([]);
let seq = 0;

/** A name for one dialog; the stack and the toast host tell dialogs apart by it. */
export const newDialogId = (): string => `dialog-${seq++}`;

/** How many dialogs are open (Base UI's `--nested-dialogs` plus one). Tracks: read it in an effect or a prop. */
export const dialogDepth = (): number => open().length;

/** The dialog on top, `undefined` when none is open. Only it answers Escape and a scrim press. */
export const topDialog = (): string | undefined => open().at(-1);

/**
 * Keeps `id` in the stack while `isOpen()` is true. The entry leaves when the dialog closes, when its owner is disposed
 * while it is open, and a dialog that opens again goes on top. Call it where the dialog is made.
 */
export function trackDialog(id: string, isOpen: () => boolean): void {
  effect(() => {
    if (!isOpen()) return;
    open.update((stack) => pushDialog(stack, id));
    return () => open.update((stack) => removeDialog(stack, id));
  });
}
