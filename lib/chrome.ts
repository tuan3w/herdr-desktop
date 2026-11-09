import { platform, signal } from "nsh";
import { isAvailable, titleBar, Window } from "nsh/desktop";

import { layout, stripsShown } from "#lib/dock";
import { BAR } from "#lib/layout";

/**
 * The window's chrome. On macOS the system title bar is hidden, so the app's own bars fill the top band (`BAR` high) and
 * the window has one line of chrome, as the Claude app and Linear do; the traffic lights stay where they were, in the area
 * `titleBar()` reports, at the band's left end, which the sidebar's first line keeps clear. Why: the system bar held only
 * the lights and a title the person never reads, 28 pt above a tab strip of 36 and a header of 48 (owner, 2026-11-09, "lots
 * of noise; clean like Linear and the Claude app").
 *
 * Windows and Linux keep the system title bar and their menu bar: there the window buttons sit at the band's right end,
 * and `DockArea` styles every group's tab bar alike, so keeping them clear took 130 pt from every group's strip, not only
 * the rightmost one (a render at 960 wrapped two tabs onto two rows); and nsh's GTK window keeps its menu bar row even with
 * `Window.setMenuBar("autoHide")` (rendered), so hiding it is not an option there.
 */
export function setWindowChrome(): void {
  if (isAvailable && platform.os === "macos") Window.setTitleBar({ style: "hidden", height: BAR });
}

/** The window controls' widths at the band's two ends (all 0 while the system draws its bar, and in the headless runner). */
export const controls = titleBar;

/**
 * What the main region keeps clear at the band's ends, set by `App` from the controls and the sidebar's width: the traffic
 * lights are wider than the rail (64), so with the rail they reach into the main region.
 */
export const mainInset = signal({ left: 0, right: 0 });

/** A pane's header is on the band (and takes `mainInset`) while no tab strip is drawn above it (`design/tabs.md`). */
export const headerOnBand = () => !stripsShown(layout());
