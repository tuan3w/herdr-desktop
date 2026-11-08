import { Herdr } from "herdr-desktop/native";
import { computed, signal, View, windowSize } from "nsh";

import type { DockTab } from "nsh/base";

import { Monogram } from "#components/project-parts";
import { Clipped, copyMenu, copyText, Icon, Tipped } from "#kit";
import { checkoutName } from "#lib/changes";
import {
  BOARD,
  closeTab,
  folderProject,
  groupOf,
  groups,
  layout,
  parseChangesKey,
  parsePaneKey,
  parseSessionKey,
  rowKeyOf,
} from "#lib/dock";
import { meta, projectOf, revision, rowOf, started } from "#lib/herdr";
import { SIDEBAR_WIDTH } from "#lib/layout";
import { appear, hoverTransition } from "#lib/motion";
import { keyLabel } from "#lib/shortcuts";
import type { GlobalShortcut } from "#lib/shortcuts";
import { statusText } from "#lib/status";
import { tabLabel } from "#lib/tabs";

/** The fills a chip can have, in the order they are laid: the ground, the resting tint, the hovered tint, the front card. */
const FADE = {
  ground: "from-background/0 to-background",
  rest: "from-sidebar-accent/0 to-sidebar-accent/40",
  hover: "from-sidebar-accent/0 to-sidebar-accent/70",
  front: "from-card/0 to-card",
} as const;

/** A chip with a title is 120 pt at least (`ROW.tab`), the front one 160; a tile-only chip is 28 and the gap 4. */
const TITLE_MIN = 120;
const FRONT_MIN = 160;
const GAP = 4;

/**
 * Whether the inactive tabs of the busiest group are drawn as a tile alone: when their titles at 120 pt would not fit
 * one row beside the front chip. The strip is nsh's `DockArea` bar and only wraps (`tab_group.rs` gives the bar the tabs
 * as its only children), so this keeps the rows few; the window's width less the default sidebar is the estimate (too
 * narrow a sidebar only makes it collapse a little early).
 */
export const tabsCompact = computed(() => {
  const most = Math.max(1, ...groups(layout()).map((g) => g.panels.length));
  const room = windowSize().width - SIDEBAR_WIDTH.default - 2 * GAP;
  return FRONT_MIN + (most - 1) * (TITLE_MIN + GAP) > room;
});

/** Every machine's link, for the dashed tile of a machine that is not online (read once per revision, like the sidebar). */
const offline = computed<Set<string>>(() => {
  if (!started()) return new Set();
  revision();
  return new Set(
    Herdr.machineStatuses()
      .filter((m) => m.state !== "online")
      .map((m) => m.id),
  );
});

/**
 * A tab's face (`design/tabs.md`): the project's tile (the one of the rail and the sidebar) with at most one badge on its
 * corner, the title cut with a fade into the chip's own fill, and a slot at the right for the cross that closes the view.
 * The slot is always there, so the cross appears on hover or in the front tab without moving the title. A terminal tab
 * reads its pane's header facts and says `(view)`: it shows the pane, it is not a terminal; a chat tab reads its row of the
 * board (a chat that is not on the board, one that ended, says `Chat`). When the strip is `tabsCompact` an inactive tab is
 * its tile alone and its tooltip says the whole identity. The front tab is a raised card (the chip's own class in
 * `workspace.tsx`), its title and icon in foreground: its place is not told by colour alone.
 */
export function TabFace(props: { tab: DockTab }) {
  const hovered = signal(false);
  const at = parsePaneKey(props.tab.panel);
  const info = at ? meta(at.machine, at.pane) : () => null;
  const chat = parseSessionKey(props.tab.panel) !== null;
  const changes = parseChangesKey(props.tab.panel);
  const row = () => {
    const key = chat ? rowKeyOf(props.tab.panel) : null;
    return key === null ? undefined : rowOf(key);
  };
  const gone = () => at !== null && (info() === null || info()!.feedState === "gone");
  const board = props.tab.panel === BOARD;
  const plain = board || changes !== null;
  const title = () =>
    board
      ? "Board"
      : changes
        ? `Changes \u00b7 ${checkoutName(changes.machine, changes.cwd)}`
        : chat
          ? (row()?.name ?? "Chat")
          : gone()
            ? "Agent gone"
            : `${info()?.name ?? at?.pane ?? ""} (view)`;
  const status = () => (chat ? (row()?.status ?? "unknown") : gone() ? "unknown" : (info()?.status ?? "unknown"));
  /** The folder the tab's agent works in (a Changes tab's checkout), when known. */
  const folder = () => changes?.cwd ?? (chat ? row()?.cwd : info()?.cwd);
  const machine = () => changes?.machine ?? (chat ? row()?.machine : at?.machine);
  /** The project this tab's tile stands for: the row's, else the one holding the folder; `undefined` for the board and unknowns. */
  const project = () => {
    if (board) return undefined;
    const key = chat
      ? row()?.project
      : changes
        ? folderProject(changes.machine, changes.cwd)
        : at && info()?.cwd
          ? folderProject(at.machine, info()!.cwd!)
          : undefined;
    return key ? projectOf(key) : undefined;
  };
  const projectName = () => project()?.name ?? (chat ? "" : title());
  const away = () => {
    const m = machine();
    return m !== undefined && offline().has(m);
  };
  const remote = () => (chat ? row()?.machineName : undefined) ?? project()?.machineName;
  const count = () => groupOf(layout(), props.tab.panel)?.panels.length ?? props.tab.index + 1;
  const word = () => (plain ? "" : statusText(status(), row()?.reviewed));
  const label = () => tabLabel(title(), word(), props.tab.index, count());
  // One badge on the tile, by precedence: needs you, then output not yet seen (a finished agent not reviewed), then working.
  const badge = () =>
    status() === "blocked"
      ? "signal"
      : status() === "done" && !props.tab.active
        ? "unseen"
        : status() === "working"
          ? "working"
          : "";
  /** The tooltip, `project \u00b7 title \u00b7 state \u00b7 machine`: the whole identity, which a tile alone cannot say. */
  const identity = () =>
    [
      project()?.name && project()?.name !== title() ? project()!.name : "",
      title(),
      word(),
      remote() && project()?.machine !== "local" ? remote() : "",
    ]
      .filter(Boolean)
      .join(" \u00b7 ");
  const slot = () => (props.tab.index < 9 ? (`tab${props.tab.index + 1}` as GlobalShortcut) : undefined);
  /** The chip's own fill around a badge, so it separates from the tile. */
  const ringFill = () => (props.tab.active ? "bg-card" : "bg-background");
  const tile = (
    <View class="relative size-4 shrink-0 items-center justify-center">
      <If
        when={board}
        else={
          <View
            style={away() ? { opacity: 0.6 } : undefined}
            class={away() ? "rounded-md border border-dashed border-muted-foreground" : ""}
          >
            <Monogram name={projectName() || "?"} size={16} />
          </View>
        }
      >
        <Icon name="list" size={14} tone={props.tab.active ? "foreground" : "muted-foreground"} />
      </If>
      <If when={changes !== null}>
        <View class={`absolute -bottom-1.5 -right-1.5 size-3.5 items-center justify-center rounded-full ${ringFill()}`}>
          <Icon name="pencil" size={12} tone="muted-foreground" />
        </View>
      </If>
      <If when={!plain && badge() === "signal"}>
        <View style={{ width: 7, height: 7 }} class="absolute -right-1 -top-1 rounded-full bg-signal" />
      </If>
      <If when={!plain && badge() === "unseen"}>
        <View style={{ width: 6, height: 6 }} class="absolute -right-1 -top-1 rounded-full bg-muted-foreground" />
      </If>
      <If when={!plain && badge() === "working"}>
        <View
          style={{ width: 9, height: 9 }}
          class="absolute -bottom-1 -right-1 overflow-hidden rounded-full border-[1.5px] border-muted-foreground"
        >
          <View class="absolute bottom-0 left-0 top-0 w-1/2 bg-muted-foreground" />
        </View>
      </If>
    </View>
  );
  const tiled = () => tabsCompact() && !props.tab.active;
  return (
    <Tipped label={identity()} shortcut={slot() ? keyLabel(slot()!) : undefined} class="w-full">
      <View
        style={appear(props.tab.panel, "fade")}
        accessibilityLabel={label()}
        onContextMenu={copyMenu(() => [
          { label: "Copy title", onSelect: () => void copyText(title(), "Title") },
          ...(folder() ? [{ label: "Copy path", onSelect: () => void copyText(folder()!, "Path") }] : []),
        ])}
        onMouseEnter={() => hovered.set(true)}
        onMouseLeave={() => hovered.set(false)}
        class={`relative h-7 w-full flex-row items-center ${tiled() ? "justify-center" : "gap-2 pl-2 pr-1"}`}
      >
        {tile}
        <If when={!tiled()}>
          <Clipped
            label={title()}
            tip={false}
            fade={props.tab.active ? [FADE.front] : hovered() ? [FADE.ground, FADE.hover] : [FADE.ground, FADE.rest]}
            boxClass="min-w-0 flex-1"
            class={`text-sm ${props.tab.active ? "text-foreground" : "text-muted-foreground"}`}
          >
            {title()}
          </Clipped>
          <View class={`shrink-0 items-center justify-center ${props.tab.closable ? "size-4" : ""}`}>
            <If when={props.tab.closable && (props.tab.active || hovered())}>
              {/* Closing is mod+w and the palette for the keyboard and screen readers: a button inside a tab would be a control within a control. */}
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Tipped label={`Close tab ${title()}`} shortcut={keyLabel("closeTab")}>
                  <View
                    role="button"
                    focusable={false}
                    accessibilityLabel={`Close tab ${title()}`}
                    onPress={() => closeTab(props.tab.panel)}
                    style={hoverTransition()}
                    class="size-4 items-center justify-center rounded-sm hover:bg-accent active:bg-accent"
                  >
                    <Icon name="x" size={14} tone="muted-foreground" />
                  </View>
                </Tipped>
              </View>
            </If>
          </View>
        </If>
      </View>
    </Tipped>
  );
}
