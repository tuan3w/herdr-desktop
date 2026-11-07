import { signal } from "nsh";

import type { PaletteScope } from "#lib/palette/scopes";

/**
 * How the rest of the app opens the palette and talks to it while it is open. The palette is one component (`components/
 * palette.tsx`); a key, a menu item and a command all reach it through here.
 */

/** The palette is open. */
export const palette = signal(false);

/** What the next opening starts with: the scope and the text (`mod+p` opens on `files`). Read once when it opens. */
export const paletteStart = signal<{ scope: PaletteScope; text: string }>({ scope: "all", text: "" });

/** What the open palette offers to the keys that are not its own: it registers while it is open. */
export const paletteHandle: { toggleActions?: () => void } = {};

/** Opens the palette on `scope`, with `text` typed; from an open palette it moves to that scope. */
export function openPalette(scope: PaletteScope = "all", text = ""): void {
  paletteStart.set({ scope, text });
  palette.set(true);
}

/**
 * `mod+k` and `mod+shift+p`: open the palette; pressed again, open the actions of the highlighted row, or leave them.
 * Escape closes it.
 */
export function paletteKey(): void {
  if (palette()) paletteHandle.toggleActions?.();
  else openPalette();
}
