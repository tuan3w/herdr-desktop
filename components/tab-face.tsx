import { Herdr } from "herdr-desktop/native";
import { computed, signal, View, windowSize } from "nsh";

import type { DockTab } from "nsh/base";
import type { ContextMenuEvent } from "nsh/types";

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
  parseFilesKey,
  parseTerminalKey,
  parseSessionKey,
  rowKeyOf,
} from "#lib/dock";
import { meta, projectOf, revision, rowOf, started } from "#lib/herdr";
import { ROW, SIDEBAR_WIDTH } from "#lib/layout";
import { appear, hoverTransition } from "#lib/motion";
import { keyLabel } from "#lib/shortcuts";
import type { GlobalShortcut } from "#lib/shortcuts";
import { statusText } from "#lib/status";
import type { AgentStatus } from "#lib/status";
import { tabLabel } from "#lib/tabs";

/** The fills a chip can have, in the order they are laid: the ground, the resting tint, the hovered tint, the front card. */
const FADE = {
  ground: "from-background/0 to-background",
  rest: "from-sidebar-accent/0 to-sidebar-accent/40",
  hover: "from-sidebar-accent/0 to-sidebar-accent/70",
  front: "from-card/0 to-card",
} as const;

/** A chip with a title is 120 pt at least (`ROW.tab`); the strip has 4 pt between chips and 4 pt of padding either side. */
const TITLE_MIN = 120;
const GAP = 4;

/**
 * Whether `most` chips of one group overflow one row of `room` points: chips share a row equally (`flex-1`), so the row
 * holds them while each still has its 120 pt. The front chip is no wider than the rest until the strip turns to tiles.
 */
export function tabsCompactFor(most: number, room: number): boolean {
  const n = Math.max(1, most);
  return n * TITLE_MIN + (n - 1) * GAP > room - 2 * GAP;
}

/**
 * The width of the dock area, as `Workspace` measured it (0 until it is laid out). Why: the window less the default
 * sidebar was the estimate, which at 760 (the rail, 64 pt) left out 200 pt, so four tabs turned to tiles that fit as chips.
 */
export const dockWidth = signal(0);

/**
 * Whether the inactive tabs of the busiest group are drawn as a tile alone: when their titles at 120 pt would not fit
 * one row of their group (the area's width shared by the groups side by side, at worst). The strip is nsh's `DockArea`
 * bar and only wraps (`tab_group.rs` gives the bar the tabs as its only children), so this keeps the rows few.
 */
export const tabsCompact = computed(() => {
  const all = groups(layout());
  const most = Math.max(1, ...all.map((g) => g.panels.length));
  const width = dockWidth() > 0 ? dockWidth() : windowSize().width - SIDEBAR_WIDTH.default;
  return tabsCompactFor(most, width / Math.max(1, all.length));
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

/** What a tab is: an agent's view (its project's tile), or a view of the app whose icon is its tile. */
export type TabKind = "agent" | "board" | "changes" | "files";

/** The one badge a tile carries, by precedence (`design/tabs.md`): needs you, then output not yet seen, then working. */
export type TabBadge = "signal" | "unseen" | "working" | "";

/** The badge of an agent's tab: a finished agent's output is "unseen" only on a tab that is not in front. */
export function tabBadge(status: AgentStatus, active: boolean): TabBadge {
  if (status === "blocked") return "signal";
  if (status === "done" && !active) return "unseen";
  if (status === "working") return "working";
  return "";
}

/**
 * Where a corner dot sits: on the tile's corner, mostly outside it, so it covers 2 pt of the tile and none of its letters
 * (at -4 pt, `-right-1`, a 7 pt dot covered the corner of the second letter of `HD`). The radius is half the size: the macOS
 * render still draws a 6 or 7 pt circle with flats (as it did with `rounded-full`), which is the host's, not fixed here.
 */
const DOT = { right: -5, top: -5 } as const;

const KIND_ICON = { board: "list", changes: "pencil", files: "folder" } as const;

/**
 * The frame `DockArea` draws around a chip (its `tabClass`): a tint at rest, a deeper one under the pointer, a raised card
 * in front (one `shadow-sm` ring in light, a hairline in dark, never both). `tiled` is the strip of tiles (`tabsCompact`).
 */
export const tabFrameClass = (tiled: boolean) =>
  `${tiled ? ROW.tabTile.class : ROW.tab.class} overflow-hidden rounded-md border border-transparent bg-sidebar-accent/40 hover:bg-sidebar-accent/70 selected:bg-card selected:hover:bg-card selected:shadow-sm dark:selected:border-border dark:selected:shadow-none`;

/**
 * What a chip draws, from facts alone (no herdr, no layout), so every case can be drawn side by side in a lab: the tile
 * (the project's `Monogram`, or the view's icon) with at most one badge on its corner, the title cut with a fade into the
 * chip's own fill, and the reserved slot of the cross. `tiled` draws the tile alone (an inactive tab of a crowded strip).
 * `hover` forces the hovered look (a lab); the chip otherwise follows the pointer itself.
 */
export function TabChip(props: {
  title: string;
  /** The project's name, for the tile's letters and tint; an agent of an unknown project shows `?`. */
  project?: string;
  kind: TabKind;
  badge: TabBadge;
  /** The machine is not online: the tile is dashed and faded. */
  away?: boolean;
  active: boolean;
  closable: boolean;
  tiled: boolean;
  hover?: boolean;
  label?: string;
  onClose?: () => void;
  onContextMenu?: (e: ContextMenuEvent) => void;
}) {
  const pointer = signal(false);
  const hovered = () => props.hover ?? pointer();
  const plain = props.kind !== "agent";
  const tile = (
    <View class="relative size-4 shrink-0 items-center justify-center">
      <If
        when={plain}
        else={
          <If when={props.away} else={<Monogram name={props.project || "?"} size={16} />}>
            {/* Offline: a dashed 16 pt frame around a 14 pt tile, faded, so the chip keeps its size when a machine drops. */}
            <View
              style={{ opacity: 0.6 }}
              class="size-4 items-center justify-center rounded-sm border border-dashed border-muted-foreground"
            >
              <Monogram name={props.project || "?"} size={14} />
            </View>
          </If>
        }
      >
        {/* A tab that is not an agent shows what it is as its tile, never a badge over a project's tile. */}
        <Icon
          name={KIND_ICON[props.kind as Exclude<TabKind, "agent">] ?? "list"}
          size={14}
          tone={props.active ? "foreground" : "muted-foreground"}
        />
      </If>
      <If when={!plain && props.badge === "signal"}>
        <View style={{ ...DOT, width: 7, height: 7, borderRadius: 3.5 }} class="absolute bg-signal" />
      </If>
      <If when={!plain && props.badge === "unseen"}>
        <View style={{ ...DOT, width: 6, height: 6, borderRadius: 3 }} class="absolute bg-muted-foreground" />
      </If>
      <If when={!plain && props.badge === "working"}>
        <View
          style={{ right: -5, bottom: -5, width: 9, height: 9, borderRadius: 4.5 }}
          class="absolute overflow-hidden border-[1.5px] border-muted-foreground"
        >
          <View class="absolute bottom-0 left-0 top-0 w-1/2 bg-muted-foreground" />
        </View>
      </If>
    </View>
  );
  return (
    <View
      accessibilityLabel={props.label}
      onContextMenu={props.onContextMenu}
      onMouseEnter={() => pointer.set(true)}
      onMouseLeave={() => pointer.set(false)}
      class={`relative h-7 w-full flex-row items-center ${props.tiled ? "justify-center" : "gap-2 pl-2 pr-1"}`}
    >
      {tile}
      <If when={!props.tiled}>
        <Clipped
          label={props.title}
          tip={false}
          fade={props.active ? [FADE.front] : hovered() ? [FADE.ground, FADE.hover] : [FADE.ground, FADE.rest]}
          boxClass="min-w-0 flex-1"
          class={`text-sm ${props.active ? "text-foreground" : "text-muted-foreground"}`}
        >
          {props.title}
        </Clipped>
        <View class={`shrink-0 items-center justify-center ${props.closable ? "size-4" : ""}`}>
          <If when={props.closable && (props.active || hovered())}>
            {/* Closing is mod+w and the palette for the keyboard and screen readers: a button inside a tab would be a control within a control. */}
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Tipped label={`Close tab ${props.title}`} shortcut={keyLabel("closeTab")}>
                <View
                  role="button"
                  focusable={false}
                  accessibilityLabel={`Close tab ${props.title}`}
                  onPress={() => props.onClose?.()}
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
  );
}

/**
 * A tab's face (`design/tabs.md`): the facts of the tab's view read from the dock and herdr, drawn by `TabChip`. A
 * terminal tab reads its pane's header facts and says `(terminal)`; a chat tab reads its row of the board (a chat that is
 * not on the board, one that ended, says `Chat`). The tooltip says the whole identity, which a tile alone cannot.
 */
export function TabFace(props: { tab: DockTab }) {
  const at = parseTerminalKey(props.tab.panel);
  const info = at ? meta(at.machine, at.pane) : () => null;
  const chat = parseSessionKey(props.tab.panel) !== null;
  const changes = parseChangesKey(props.tab.panel);
  const files = parseFilesKey(props.tab.panel);
  const row = () => {
    const key = chat ? rowKeyOf(props.tab.panel) : null;
    return key === null ? undefined : rowOf(key);
  };
  const gone = () => at !== null && (info() === null || info()!.feedState === "gone");
  const board = props.tab.panel === BOARD;
  const kind: TabKind = board ? "board" : changes ? "changes" : files ? "files" : "agent";
  const plain = kind !== "agent";
  const title = () =>
    board
      ? "Board"
      : changes
        ? `Changes \u00b7 ${checkoutName(changes.machine, changes.cwd)}`
        : files
          ? `Files \u00b7 ${files.dir.replace(/\/+$/, "").split("/").pop() || "/"}`
          : chat
            ? (row()?.name ?? "Chat")
            : gone()
              ? "Agent gone"
              : `${info()?.name ?? at?.pane ?? ""} (terminal)`;
  const status = () => (chat ? (row()?.status ?? "unknown") : gone() ? "unknown" : (info()?.status ?? "unknown"));
  /** The folder the tab's agent works in (a Changes tab's checkout), when known. */
  const folder = () => changes?.cwd ?? files?.dir ?? (chat ? row()?.cwd : info()?.cwd);
  const machine = () => changes?.machine ?? files?.machine ?? (chat ? row()?.machine : at?.machine);
  /** The project this tab's tile stands for: the row's, else the one holding the folder; `undefined` for the board and unknowns. */
  const project = () => {
    if (board) return undefined;
    const key = chat
      ? row()?.project
      : changes
        ? folderProject(changes.machine, changes.cwd)
        : files
          ? folderProject(files.machine, files.dir)
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
  return (
    <Tipped label={identity()} shortcut={slot() ? keyLabel(slot()!) : undefined} class="w-full">
      <View style={appear(props.tab.panel, "fade")} class="w-full">
        <TabChip
          title={title()}
          project={projectName()}
          kind={kind}
          badge={plain ? "" : tabBadge(status(), props.tab.active)}
          away={away()}
          active={props.tab.active}
          closable={props.tab.closable}
          tiled={tabsCompact() && !props.tab.active}
          label={tabLabel(title(), word(), props.tab.index, count())}
          onClose={() => closeTab(props.tab.panel)}
          onContextMenu={copyMenu(() => [
            { label: "Copy title", onSelect: () => void copyText(title(), "Title") },
            ...(folder() ? [{ label: "Copy path", onSelect: () => void copyText(folder()!, "Path") }] : []),
          ])}
        />
      </View>
    </Tipped>
  );
}
