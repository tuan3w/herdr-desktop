# Tabs

Two strips exist, and a window with one thing open draws neither.

- **Main-region tabs**: one tab per open view of the agent being worked on (its Chat or terminal view, and files opened from the inspector), plus the Board. The strip is drawn **only when two or more tabs exist**. Why: a single tab drew a strip, truncated, over empty width and took height from the conversation for no choice. The strip belongs to nsh's `DockArea`; a single tab is its title in the one header line. Built as `stripsShown(layout)` (`lib/dock.ts`) feeding `tabBarClass` (`hidden` when false). **One group** with one panel: no strip. **Several groups**: every group keeps its strip, even a group of one, so a drop target and the cross stay visible. Each project has its own layout, so the Board (home) and an agent (its project) are never two tabs of one strip: an agent alone in its project draws none. A hidden bar is not in the accessibility tree: there is no `role:tab` then (tests count 0) and the view's own header names it; `mod+w`, `mod+shift+1..9` and the palette work either way.
- **Inspector tabs** (decided, not built yet): Overview, Changes, Files, Terminal. Opening a file from Files adds a tab beside Chat in the main region, not a tab in the inspector. The inspector remembers its open tab and its collapsed state.

The rest of this page is the main-region strip as built. `DockArea` owns the bar, the drag and the selection; `components/tab-face.tsx` (`TabFace`) is what a tab shows, `components/workspace.tsx` sets the bar's and the tab's classes, `ROW.tab` in `lib/layout.ts` is the tab's height (see that file for the number: the type-scale cutover changes it). `TabBar` and `TabItem` of the kit (`design/components.md`) are the filter chips of one record, not this.

## Rules

- **A tab has a width.** At least `min-w-40` (160 pt), at most `max-w-56` (224 pt). Tabs of one row share the row equally between those two, so a tab never overlaps its neighbour: the frame clips (`overflow-hidden`) and the title is `Clipped`, one line, ellipsis.
- **What is in a tab, left to right**: the state shape (`StatusGlyph`, small; the board has an icon instead), the title, and a reserved slot for the cross. A separator on the right and one over the tab (`border-r`, `border-t`); the bar has its line under it. A tab shows no state word and no loud mark: the agent's mark is on its sidebar row (`design/attention.md`).
- **The front tab is told apart three ways:** the surface step to `background` (the bar is `sidebar`), the title in `foreground` against `muted-foreground`, and a 2-pt `primary` underline. Weight never changes, so no tab changes width when it is selected. Why: a weight swap reflows the title by a pixel. A tab the pointer is over takes `sidebar-accent/60`.
- **The cross is always where it will be.** The slot is reserved, so the cross appears in the front tab and in the tab the pointer is over without moving a letter; it is not drawn in other tabs, so a click at the right end of one cannot close it. The cross is not a Tab stop and not read by a screen reader (`mod+w` and the palette close a tab: a control inside a tab would be a control within a control). Not on the board.
- **A title that is cut says all of it** in the bubble of `Clipped` when the pointer rests on it. The tab's name for a screen reader is `<title>, <state>, tab 3 of 8` (`tabLabel`), the whole title always.
- **Right click** on a tab offers `Copy title` and, when the folder is known, `Copy path` (`copyText`, which toasts and announces `Title copied`). A sidebar agent offers `Copy name` and `Copy folder`; a project's name does too and its options menu has them as well.
- **Focus** is the inset ring (`FOCUS_RING_INSET`), inside the tab's edge so the clip does not cut it.
- **When the tabs do not fit, the bar wraps** to a second row, and a third: every tab stays visible and the front one is never out of sight. A strip that scrolls was not possible: a view in nsh 0.4.0 never scrolls (`overflow-x-hidden` only clips) and the bar is the area's own view. `mod+shift+1`..`9` (`selectNth`) and the Switcher reach any tab by key.
- **Drag** is the area's. Dropping on a bar of several rows picks the slot by the horizontal position only (nsh's `tab_group.rs` sorts the tabs by x), so across rows the slot may be off by a row; `Move tab to split …` in the palette is the exact way.

## How it was found

The first bar had tabs `flex-row` with the title's width and no clip: nine long titles overlapped, ran past the right edge and the front tab could be out of sight (`.shots/scenarios.ts` `tabs-many`). A tab's content must be a block of a fixed height in a column frame: `absolute inset-0` makes it zero wide, because the area wraps `renderTab` in a view of its own. Seen on a real GTK window under Xvfb; the headless harness has no layout.

## Looked at

`tabs-few`, `tabs-many` and `tabs-twenty` of `.shots/scenarios.ts` at 1280, 960 and 760, light and dark, and the hover of a tab in `components/tabs.test.tsx`; `make a11y` lists each tab as a `page tab` with its full name. The strip hidden for a single tab (built): macOS shots `tabs-board-alone`, `tabs-one-agent`, `tabs-two-agents` (`.scratch/shots-mac/`). Seen: no empty band where the strip was, the view starts at the window's top edge; the chat header's text sits closer to that edge than the Board's first line does, a small jump between the two views (unfixed).
