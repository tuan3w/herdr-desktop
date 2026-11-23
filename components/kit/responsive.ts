import { signal, windowSize } from "nsh";

import { sidebarCollapsed } from "#lib/settings";

/**
 * Below this window width the sidebar collapses to a rail of project tiles and panes narrow. The full sidebar needs about
 * 220pt and the home about 680pt beside it, so 900 is where the rail starts to read better than the list.
 */
export const COMPACT_WIDTH = 900;

/** Below this window width the full sidebar is its narrow width (`SIDEBAR_WIDTH.narrow`) and its edge cannot be dragged. */
export const SNUG_WIDTH = 1100;

/**
 * The headless test engine's `windowSize()` can report the phone-sized default (390 pt) on the first draw, before the
 * `open()` width takes effect. A test names the width it wants the responsive rules to see through
 * `host.params.testWidth`; `App.tsx` hands it to this signal at startup, before the first render. The real app never
 * sets it, so `windowSize()` is the source.
 */
const testWidth = signal<number | null>(null);
export function setTestWidth(w: number | null): void {
  testWidth.set(w);
}

const width = (): number => testWidth() ?? windowSize().width;

/** True while the window is narrower than `SNUG_WIDTH`. Reactive. */
export const snug = () => width() < SNUG_WIDTH;

/** True while the window is narrower than `COMPACT_WIDTH`. Reactive. */
export const compact = () => width() < COMPACT_WIDTH;

/**
 * True while the sidebar is an icon rail: a narrow window, or the user kept it collapsed. Reactive.
 */
export const rail = () => compact() || sidebarCollapsed();

/** Below this window width two-pane screens show one pane at a time and side-by-side columns stack. */
export const NARROW_WIDTH = 860;

/** True while the window is narrower than `NARROW_WIDTH`. Reactive. */
export const narrow = () => width() < NARROW_WIDTH;
