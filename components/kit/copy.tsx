import { Clipboard } from "nsh";
import { isAvailable, Menu } from "nsh/desktop";

import type { ContextMenuEvent } from "nsh";

import { notify } from "./notify";

/**
 * The one place an explicit copy (a button, a menu item, a shortcut) puts text on the clipboard: it says what it copied
 * (`Path copied`, a toast that is also announced politely) and, when the clipboard refuses, says so in words. A copy the
 * person makes by selecting text and pressing Ctrl+C is the host's own and is not announced.
 */
export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await Clipboard.writeText(text);
  } catch (e) {
    notify(`Could not copy the ${what.toLowerCase()}: ${e instanceof Error ? e.message : String(e)}`, {
      type: "error",
    });
    return false;
  }
  notify(`${what} copied`);
  return true;
}

/** An item of a context menu: what it says and what it does. */
export interface CopyEntry {
  label: string;
  onSelect: () => void;
}

/**
 * The right-click handler of text the person may want to take: a menu of explicit copies (`Copy message`, `Copy code`),
 * none of which needs a selection. The host's own `Copy` and `Select All` are left out on purpose: a native menu takes
 * the keyboard focus, which ends the selection on GTK before the item runs, so those two did nothing (seen in a real
 * window); the keys (Ctrl+C, Ctrl+A, Ctrl+Insert) and the primary selection (middle click) act on the selection itself.
 * With no entries there is no menu. Put it on the view that holds the text: `<View onContextMenu={copyMenu(entries)}>`.
 */
export function copyMenu(entries: () => readonly CopyEntry[]) {
  return (e: ContextMenuEvent) => {
    if (!isAvailable) return;
    const items = entries();
    if (items.length === 0) return;
    void Menu.popup(
      items.map((item) => ({ label: item.label, onSelect: item.onSelect })),
      e.pagePosition,
    );
  };
}
