import { windowSize } from "nsh";
import { sidebarCollapsed } from "../../lib/settings";

/** Below this window width the sidebar collapses to an icon rail and panes narrow. Everything must work down to 900. */
export const COMPACT_WIDTH = 1100;

/** True while the window is narrower than `COMPACT_WIDTH`. Reactive. */
export const compact = () => windowSize().width < COMPACT_WIDTH;

/** True while the sidebar is an icon rail: a narrow window, or the user kept it collapsed. Reactive. */
export const rail = () => compact() || sidebarCollapsed();

/** Width of the icon rail in points: 40pt rows and 8pt padding either side. */
export const RAIL_WIDTH = 56;

/** Below this window width two-pane screens show one pane at a time and side-by-side columns stack. */
export const NARROW_WIDTH = 860;

/** True while the window is narrower than `NARROW_WIDTH`. Reactive. */
export const narrow = () => windowSize().width < NARROW_WIDTH;
