# The tab bar

The strip over each tab group of the workspace: one tab per open agent view (a terminal view, a chat, a Changes tab) and the board. `DockArea` (nsh's) owns the bar, the drag and the selection; `components/tab-face.tsx` (`TabFace`) is what a tab shows, `components/workspace.tsx` sets the bar's and the tab's classes, `ROW.tab` in `lib/layout.ts` is the tab's size. This page is only the strip. `TabBar` and `TabItem` of the kit (`design/components.md`) are the filter chips of one record, not this.

## Rules

- **A tab has a width.** At least `min-w-40` (160 pt), at most `max-w-56` (224 pt), 36 pt tall (`ROW.tab`). Tabs of one row share the row equally between those two, so a tab never overlaps its neighbour: the frame clips (`overflow-hidden`) and the title is `Clipped`, one line, ellipsis.
- **What is in a tab, left to right** (4-pt steps: 12, 12, 8, title, 24, 4): the state shape (`StatusGlyph` at 12 pt; the board and Changes have an icon instead), the title, and a 24-pt slot for the cross. A separator line on the right and one over the tab (`border-r`, `border-t`); the bar has its line under it.
- **The front tab is told apart three ways:** the surface step to `background` (the bar is `sidebar`), the title in `foreground` against `muted-foreground`, and a 2-pt `primary` underline. Weight never changes, so no tab changes width when it is selected. A tab the pointer is over takes `sidebar-accent/60`.
- **The cross is always where it will be.** The slot is reserved, so the cross appears in the front tab and in the tab the pointer is over without moving a letter; it is not drawn in other tabs, so a click at the right end of one cannot close it. The cross is not a Tab stop and not read by a screen reader (`mod+w` and the palette close a tab: a control inside a tab would be a control within a control). Not on the board.
- **A title that is cut says all of it** in the bubble of `Clipped` when the pointer rests on it. The tab's name for a screen reader is `<title>, <state>, tab 3 of 8` (`tabLabel`; the board and Changes have no state), the whole title always.
- **Right click** on a tab offers `Copy title` and, when the folder is known, `Copy path` (`copyText`, which toasts and announces `Title copied`). A sidebar agent offers `Copy name` and `Copy folder`; a project's name does too and its options menu has them as well.
- **Focus** is the inset ring (`FOCUS_RING_INSET`), inside the tab's edge so the clip does not cut it.
- **When the tabs do not fit, the bar wraps.** Tabs that cannot keep 160 pt move to a second row, and a third: every tab stays visible and clickable and the front one is never out of sight. A strip that scrolls was not possible: a view in nsh 0.4.0 never scrolls (`overflow-x-hidden` only clips) and the bar is the area's own view, not ours. Wrapping costs a row of 36 pt per six tabs at 1280 (four at 960 and below) and is the behaviour of an editor with wrapped tabs; twenty tabs are four or five rows. `mod+shift+1`..`9` (`selectNth`) and the Switcher reach any tab by key.
- **Drag** is the area's. Dropping on a bar of several rows picks the slot by the horizontal position only (nsh's `tab_group.rs` sorts the tabs by x), so across rows the slot may be off by a row; `Move tab to split …` in the palette is the exact way.

## How it was found

The first bar had tabs `flex-row` with the title's width and no clip: nine long titles overlapped, ran past the right edge and the front tab could be out of sight (`.shots/scenarios.ts` `tabs-many`). Seen on a real GTK window under Xvfb; the headless harness has no layout. A tab's content must be a block of a fixed height (`h-9 w-full`) in a column frame: `absolute inset-0` makes it zero wide, because the area wraps `renderTab` in a view of its own, and a row frame lets that view grow to the title's width.

## Looked at

`tabs-few`, `tabs-many` and `tabs-twenty` of `.shots/scenarios.ts` (the `tabs` fixture: one project, twenty agents with long names, each opened with `mod+j`) at 1280, 960 and 760, light and dark, and the hover of a tab in `components/tabs.test.tsx` on the headless harness and on a GTK window (a hover in an audited scenario made the AT-SPI audit lose the app); `make a11y` lists each tab as a `page tab` with its full name and no unnamed control.
