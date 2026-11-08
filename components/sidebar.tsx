import { Herdr } from "herdr-desktop/native";
import { announce, computed, effect, List, Scroll, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { BoardProject, BoardRow, MachineStatus } from "herdr-desktop/native";
import type { JSX } from "nsh";
import type { ListRef } from "nsh/types";

import { PickSlot, useRowKeys } from "#components/pick-box";
import { Monogram, ProjectMark } from "#components/project-parts";
import { SidebarFooter } from "#components/sidebar-footer";
import { StatusGlyph } from "#components/status-glyph";
import {
  ActionMenu,
  Badge,
  Clipped,
  compact,
  copyMenu,
  copyText,
  FOCUS_RING_SIDEBAR,
  Icon,
  type IconName,
  IconButton,
  Kbd,
  NUM,
  Popover,
  PopoverTitle,
  rail,
  SearchField,
  snug,
  Tipped,
  usePopover,
  useTriggerFocus,
} from "#kit";
import { newSession, openSettings, settingsPage, sidebarSearch } from "#lib/actions";
import { checkoutsOf, openChanges } from "#lib/changes";
import { BOARD, context, focused, rowKeyOf, showBoard } from "#lib/dock";
import { actionSlot, headerBudget } from "#lib/header-fit";
import { board, projectOf, revision, rowOf, started } from "#lib/herdr";
import { ROW } from "#lib/layout";
import { ofKind } from "#lib/list-item";
import { linkGlyph, linkText } from "#lib/machine-state";
import { hoverTransition, moveTransition } from "#lib/motion";
import { openProject } from "#lib/nav";
import { openAgent } from "#lib/open-agent";
import { largeTargets, setSidebarCollapsed } from "#lib/settings";
import { keyLabel } from "#lib/shortcuts";
import {
  ageText,
  foldedProjects,
  moreOpen,
  projectFolder,
  projectLabel,
  projectState,
  rowLabel,
  keepItems,
  type SidebarItem,
  sidebarItems,
  toggleMore,
  toggleProject,
  treeOffset,
} from "#lib/sidebar";
import { stateWord } from "#lib/status";

/** Hover and the open tab are a quiet fill, nothing else. The focus ring is inset: see `FOCUS_RING_SIDEBAR`. */
const FILL = `rounded-md hover:bg-sidebar-accent/40 selected:bg-sidebar-accent ${FOCUS_RING_SIDEBAR}`;

/**
 * What a cut title fades into (`Clipped` `fade`): each fill its row can have, laid in order: the sidebar, the row's hover
 * tint and, for the open one, its selected fill. Same tokens as `ROW_FILL`, so the fade and the fill are one colour.
 */
const FADE = "from-sidebar/0 to-sidebar";
const FADE_HOVER = "from-sidebar-accent/0 to-sidebar-accent/40 opacity-0 group-hover/row:opacity-100";
const FADE_OPEN = "from-sidebar-accent/0 to-sidebar-accent";

/** An agent's fill follows its row (`group/row`), which holds the line and the `...` over its edge. */
const ROW_FILL = `rounded-md group-hover/row:bg-sidebar-accent/40 selected:bg-sidebar-accent ${FOCUS_RING_SIDEBAR}`;

const query = signal("");

/** Every machine's link. Empty until the engine runs: this computed is built when the module loads, before `Herdr.configure`. */
const statuses = computed<MachineStatus[]>(() => {
  if (!started()) return [];
  revision();
  return Herdr.machineStatuses();
});

let shown: SidebarItem[] = [];
const items = computed(
  () => (shown = keepItems(shown, sidebarItems(board(), statuses(), query(), foldedProjects(), moreOpen()))),
);
const rowKeys = computed(() => items().flatMap((i) => (i.kind === "row" ? [i.row.key] : [])));

/** The agent whose tab is the one being worked in: its row is lit, and in the rail so is its project's tile. */
const openRow = computed(() => {
  const key = rowKeyOf(focused());
  return key === null ? undefined : rowOf(key);
});

const isOpen = (row: BoardRow) => openRow()?.key === row.key;
const nameOf = (projectKey: string) => projectOf(projectKey)?.name ?? "";

/** One line of the top group: icon, label, then `children` (a count, a keycap) at the far end; in the rail the icon alone. */
function NavRow(props: {
  icon: IconName;
  label: string;
  name?: string;
  shortcut?: string;
  selected?: boolean;
  onPress: () => void;
  mark?: JSX.Element;
  children?: JSX.Element;
}) {
  return (
    <Tipped label={props.label} shortcut={props.shortcut} class={rail() ? "items-center" : undefined}>
      <Button
        onPress={props.onPress}
        selected={props.selected}
        accessibilityLabel={props.name ?? props.label}
        style={hoverTransition()}
        class={`flex-row items-center ${FILL} ${rail() ? "size-11 justify-center" : `justify-between ${ROW.nav.class}`}`}
      >
        <View class="flex-row items-center gap-3">
          <Icon name={props.icon} tone={props.selected ? "sidebar-foreground" : "muted-foreground"} />
          <If when={!rail()}>
            <Text class="text-sm text-sidebar-foreground">{props.label}</Text>
          </If>
        </View>
        <If when={!rail()}>{props.children}</If>
        <If when={rail()}>{props.mark}</If>
      </Button>
    </Tipped>
  );
}

/** A machine that is not online, in the rail: its state is a glyph, because a problem must not hide behind the tiles. */
function MachineGlyph(props: { status: MachineStatus }) {
  const label = () => `${props.status.name}, ${linkText(props.status)}`;
  return (
    <Tipped label={label()} class="items-center">
      <Button
        onPress={() => openSettings("machines")}
        accessibilityLabel={label()}
        style={hoverTransition()}
        class={`size-11 items-center justify-center ${FILL}`}
      >
        <StatusGlyph status={linkGlyph(props.status.state)} />
      </Button>
    </Tipped>
  );
}

/** `Review changes`: one entry for a project with one checkout, one per checkout (named by its folder) for a project with several. */
function changesEntries(project: BoardProject) {
  const checkouts = checkoutsOf(project);
  const keys = keyLabel("changes");
  if (checkouts.length <= 1)
    return [
      {
        label: "Review changes",
        shortcut: keys,
        onSelect: () => void openChanges(project.machine, checkouts[0].path),
        disabled: project.offline || checkouts.length === 0,
      },
    ];
  return checkouts.map((c) => ({
    label: `Review changes in ${c.name}`,
    onSelect: () => void openChanges(project.machine, c.path),
    disabled: project.offline,
  }));
}

/** `Copy name` and, when the folder is known, `Copy folder`: the explicit copies of a row's context menu and a project's options. */
function copyEntries(nameWhat: string, name: string, pathWhat: string, path: string | null | undefined) {
  return [
    { label: "Copy name", accelerator: "C", onSelect: () => void copyText(name, nameWhat) },
    ...(path ? [{ label: "Copy folder", accelerator: "F", onSelect: () => void copyText(path, pathWhat) }] : []),
  ];
}

/** `Open project`: the project's page; the header's press folds, so this is where the page is reached. */
const openEntry = (project: BoardProject) => ({
  label: "Open project",
  accelerator: "O",
  onSelect: () => openProject(project.key),
});

/** What a project's menu offers: show its tabs, pin it, start a chat in it, review what its agents changed. */
function projectEntries(project: BoardProject) {
  return [
    openEntry(project),
    {
      label: "Open here",
      accelerator: "H",
      // The project's first agent (those that need you come first) as a tab of the workspace shown, not of its project.
      onSelect: () => {
        const row = project.rows[0];
        if (row) void openAgent(row, { here: true });
      },
      disabled: project.rows.length === 0,
    },
    {
      label: project.pinned ? "Unpin" : "Pin to the top",
      accelerator: "P",
      onSelect: () => Herdr.pinProject(project.key, !project.pinned),
    },
    {
      label: "New agent session here…",
      accelerator: "N",
      onSelect: () => newSession({ machine: project.machine, folder: projectFolder(project) }),
      disabled: project.offline,
    },
    ...changesEntries(project),
    ...copyEntries("Project name", project.name, "Folder", projectFolder(project)),
  ];
}

/** The header button's left padding (`pl-3`), which `headerBudget` takes off the line. */
const HEADER_PAD = 12;

/**
 * A project: one quiet line, the name with a small chevron right after it, its machine (muted, amber when stale; none for
 * this computer), while folded how many of its agents wait (the signal dot and the number) and, on hover or focus over it,
 * a plus (a new session in its folder) and its menu at the free right edge. The whole line is one button that folds it: no
 * fill on hover, because the name and the chevron are one thing; `Open project` is the menu's first entry.
 * Its text starts at the left edge of the agents' glyphs. The row reads its item and holds no state, because the list recycles cells.
 */
function Project(props: { item: () => Extract<SidebarItem, { kind: "project" }> }) {
  const p = () => props.item().project;
  // The line's width, so the name and the machine are given explicit room (`headerBudget`); the slot at the right edge is
  // held back whether or not the actions show, so nothing reflows on hover.
  const width = signal(0);
  const menuOpen = signal(false);
  const slot = () => actionSlot({ plus: true, large: largeTargets() });
  const fit = () => {
    if (width() === 0) return undefined;
    const extra = (props.item().folded ? 40 : 0) + (p().pinned ? 12 : 0);
    return headerBudget({
      name: p().name.length,
      machine: (props.item().machine ?? "").length,
      width: width() - HEADER_PAD - slot() - extra,
      extra,
    });
  };
  return (
    <View role="group" accessibilityLabel={projectLabel(p())} class={`group mt-3 ${p().offline ? "opacity-60" : ""}`}>
      <Tipped label={[p().name, props.item().machine].filter(Boolean).join(" · ")}>
        <View
          role="button"
          onPress={() => toggleProject(p().key)}
          onContextMenu={copyMenu(() => [
            openEntry(p()),
            ...copyEntries("Project name", p().name, "Folder", projectFolder(p())),
          ])}
          onLayout={({ bounds }) => width.set(bounds.size.width)}
          accessibilityLabel={`${props.item().folded ? "Unfold" : "Fold"} ${p().name}`}
          accessibilityState={{ expanded: !props.item().folded }}
          style={{ paddingRight: slot() }}
          class={`flex-row items-center gap-1.5 min-h-7 pl-3 rounded-md ${FOCUS_RING_SIDEBAR}`}
        >
          <View class="min-w-0 shrink-[1]" style={{ maxWidth: fit()?.name }}>
            <Clipped fade={[FADE]} boxClass="min-w-0" class="text-sm font-medium text-muted-foreground">
              {p().name}
            </Clipped>
          </View>
          <View
            style={moveTransition()}
            class={props.item().folded ? "" : "rotate-90"}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Icon name="chevron-right" size={12} tone="muted-foreground" />
          </View>
          <If when={p().pinned}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              class="size-1.5 rounded-full bg-sidebar-foreground"
            />
          </If>
          <If when={props.item().machine !== null && (fit()?.machine ?? 1) > 0}>
            <View class="min-w-0 shrink-[100]" style={{ maxWidth: fit()?.machine }}>
              <Clipped
                fade={[FADE]}
                boxClass="min-w-0"
                class={`text-xs ${props.item().stale ? "text-warning" : "text-muted-foreground"}`}
              >
                {props.item().machine ?? ""}
              </Clipped>
            </View>
          </If>
          <If when={props.item().folded}>
            <View class="ml-auto pl-2">
              <ProjectMark project={p()} compact onSidebar />
            </View>
          </If>
        </View>
      </Tipped>
      <View
        class={`absolute bottom-0 right-0 top-0 flex-row items-center gap-0.5 pr-1 ${
          menuOpen() ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        }`}
      >
        <IconButton
          onSidebar
          roomy
          icon="plus"
          label={`New agent session in ${p().name}`}
          tip="New session"
          disabled={p().offline}
          onPress={() => newSession({ machine: p().machine, folder: projectFolder(p()) })}
        />
        <ActionMenu
          label={`Options for ${p().name}`}
          entries={projectEntries(p())}
          onOpenChange={(open) => menuOpen.set(open)}
        />
      </View>
    </View>
  );
}

/** A checkout of a project that has several: the worktree a group of agents works in. */
function Checkout(props: { item: () => Extract<SidebarItem, { kind: "checkout" }> }) {
  const c = () => props.item().checkout;
  return (
    <View
      class="flex-row items-center gap-2 pl-8 pr-3 pt-2"
      accessibilityLabel={c().linked ? `${c().name}, worktree` : `${c().name}, main checkout`}
    >
      <Clipped class="min-w-0 shrink text-xs text-muted-foreground">{c().name}</Clipped>
      <Text class="text-xs text-muted-foreground">{c().linked ? "worktree" : "main"}</Text>
    </View>
  );
}

/**
 * What the compact row leaves out, for the bubble: the state in words (a glyph alone is not readable by eye), the agent
 * (or chat), its machine and how long. The accessible name (`rowLabel`) still carries all of it, so a screen reader loses
 * nothing.
 */
const rowDetail = (row: BoardRow) =>
  [stateWord(row.status, row.reviewed), row.agent, row.session ? "chat" : "", row.machineName, ageText(row.sinceSecs)]
    .filter(Boolean)
    .join(" · ");

/**
 * An agent in one line: its state as a quiet shape and its name. A stale machine's agent is a dashed ring, no word (`rowLabel` still says
 * `offline`); the program, machine and age are in the bubble and in the accessible name. The box that picks it for a bulk action takes the
 * glyph's place on hover.
 */
function Agent(props: { item: () => Extract<SidebarItem, { kind: "row" }> }) {
  const row = () => props.item().row;
  const menuOpen = signal(false);
  return (
    <View class={`group/row relative ${props.item().nested ? "pl-3" : ""}`}>
      <Tipped label={rowDetail(row())}>
        <AgentButton item={props.item} />
      </Tipped>
      <PickSlot rowKey={row().key} name={row().name} order={rowKeys} surface="sidebar" nested={props.item().nested} />
      <View
        class={`absolute inset-y-0 right-1 items-center justify-center ${
          menuOpen() ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
        }`}
      >
        <ActionMenu
          label={`Options for ${row().name}`}
          entries={copyEntries("Name", row().name, "Folder", row().cwd)}
          onOpenChange={(open) => menuOpen.set(open)}
        />
      </View>
    </View>
  );
}

/**
 * The pressable line, apart from `Agent` so `useTriggerFocus` is called inside the bubble's trigger. Its fill is the row's
 * (`group/row`), not its own, so it stays lit while the pointer is on the `...` that sits over its right edge; the title
 * ends before that slot, held back at rest as on hover.
 */
function AgentButton(props: { item: () => Extract<SidebarItem, { kind: "row" }> }) {
  const row = () => props.item().row;
  const keys = useRowKeys(row, rowKeys);
  const tip = useTriggerFocus();
  return (
    <View
      role="button"
      onPress={() => void openAgent(row())}
      onContextMenu={copyMenu(() => copyEntries("Name", row().name, "Folder", row().cwd))}
      accessibilityState={{ selected: isOpen(row()) }}
      accessibilityLabel={rowLabel(row(), nameOf(props.item().project))}
      onFocus={() => {
        keys.onFocus();
        tip.onFocus?.();
      }}
      onBlur={() => {
        keys.onBlur();
        tip.onBlur?.();
      }}
      style={[hoverTransition(), { paddingRight: actionSlot({ plus: false, large: largeTargets() }) }]}
      class={`min-w-0 flex-row items-center gap-3 ${ROW.agentCompact.class} ${ROW_FILL} ${row().offline ? "opacity-60" : ""}`}
    >
      <StatusGlyph status={row().offline ? "unknown" : row().status} id={row().key} />
      <Clipped
        fade={isOpen(row()) ? [FADE, FADE_OPEN] : [FADE, FADE_HOVER]}
        boxClass="min-w-0 flex-1"
        class="text-sm text-sidebar-foreground"
      >
        {row().name}
      </Clipped>
    </View>
  );
}

function More(props: { item: () => Extract<SidebarItem, { kind: "more" }> }) {
  const it = props.item;
  const text = () => (it().open ? "Show fewer idle" : `${it().count} more idle`);
  return (
    <View
      role="button"
      onPress={() => toggleMore(it().project)}
      accessibilityLabel={`${text()} in ${nameOf(it().project)}`}
      accessibilityState={{ expanded: it().open }}
      style={hoverTransition()}
      class={`justify-center pl-9 pr-3 ${ROW.more.class} ${FILL}`}
    >
      <Text class="text-xs text-muted-foreground">{text()}</Text>
    </View>
  );
}

/** The tree: projects, checkouts, agents. Rows are recycled, so each reads its item and holds nothing of its own. */
function Tree() {
  let list: ListRef | undefined;
  /** The lines in view, by key: the open agent's line is brought in only when it is not one of them. */
  const inView = new Set<string>();
  let revealed = openRow()?.key;
  // The place follows the person's own move (another tab, a switch, `mod+j`), never a tick: the open row is read here as
  // a key, and a new object for the same agent is not a move.
  effect(() => {
    const key = openRow()?.key;
    if (key === revealed) return;
    revealed = key;
    untracked(() => {
      const at = items().findIndex((i) => i.key === key);
      if (at >= 0 && !inView.has(key!)) list?.scrollToIndex({ index: at, viewPosition: 0.5, animated: false });
    });
  });
  return (
    <List
      ref={(node: ListRef) => {
        list = node;
      }}
      onViewableItemsChange={({ changed }) => {
        for (const t of changed) {
          if (t.isViewable) inView.add(t.key);
          else inView.delete(t.key);
        }
      }}
      each={items()}
      keyExtractor={(i: SidebarItem) => i.key}
      estimatedItemSize={ROW.agentCompact.height}
      class="min-h-0 flex-1"
      contentClass="gap-1"
      scrollEventThrottle={50}
      onScroll={(e) => treeOffset.set(e.offset.y)}
      accessibilityLabel="Projects and agents"
    >
      {(item) => {
        const project = ofKind(item, "project");
        const checkout = ofKind(item, "checkout");
        const row = ofKind(item, "row");
        const more = ofKind(item, "more");
        return (
          <If
            when={item().kind === "project"}
            else={
              <If
                when={item().kind === "checkout"}
                else={
                  <If when={item().kind === "row"} else={<More item={more} />}>
                    <Agent item={row} />
                  </If>
                }
              >
                <Checkout item={checkout} />
              </If>
            }
          >
            <Project item={project} />
          </If>
        );
      }}
    </List>
  );
}

/** The agents of a project, in the popover a rail tile opens: a press opens the agent and closes the popover. */
function RailAgent(props: { row: BoardRow; project: BoardProject }) {
  const popover = usePopover();
  return (
    <View
      role="button"
      accessibilityLabel={rowLabel(props.row, props.project.name)}
      onPress={() => {
        void openAgent(props.row);
        popover.close();
      }}
      {...popover.focus}
      style={hoverTransition()}
      class={`flex-row items-center gap-3 rounded-md ${ROW.agentCompact.class} hover:bg-accent ${FOCUS_RING_SIDEBAR} ${props.row.offline ? "opacity-60" : ""}`}
    >
      <StatusGlyph status={props.row.status} />
      <Clipped fade={["from-popover/0 to-popover"]} boxClass="min-w-0 flex-1" class="text-sm text-foreground">
        {props.row.name}
      </Clipped>
      <Text style={NUM} class="text-xs text-muted-foreground">
        {ageText(props.row.sinceSecs)}
      </Text>
    </View>
  );
}

/**
 * `Show project` in the popover of a rail tile: the project's tabs, as the full sidebar's `Switch to this project`. A view
 * that spreads the popover's focus like `RailAgent`, not a `Btn`: nsh's `Button` reports no focus, so Tab onto it counted as
 * the focus leaving the popover and closed it.
 */
function RailShow(props: { project: BoardProject }) {
  const popover = usePopover();
  return (
    <View class="items-start py-1">
      <View
        role="button"
        accessibilityLabel={`Show ${props.project.name}`}
        onPress={() => {
          openProject(props.project.key);
          popover.close();
        }}
        {...popover.focus}
        style={hoverTransition()}
        class={`min-h-7 flex-row items-center justify-center rounded-md border border-input bg-card px-3 hover:bg-accent active:bg-accent ${FOCUS_RING_SIDEBAR}`}
      >
        <Text class="text-xs font-medium text-foreground">Show project</Text>
      </View>
    </View>
  );
}

/**
 * A project in the rail: a tile with its first letters and, in a corner, the signal dot while something waits (the number
 * is the tooltip and the accessible name; the rail has no room for words). Pinned projects carry a small ink dot, the
 * project being worked in is lit. A press opens a popover with the project's agents (the sidebar cannot widen in a
 * narrow window).
 */
function RailTile(props: { project: BoardProject }) {
  const p = () => props.project;
  const lit = () => context() === p().key;
  const label = () => projectLabel(p());
  return (
    <Popover
      side="right"
      align="start"
      class="items-center"
      popupClass="w-72"
      trigger={(t) => (
        <Tipped label={label()} class="items-center">
          <View
            role="button"
            accessibilityLabel={label()}
            accessibilityState={{ expanded: t.expanded(), selected: lit() }}
            onPress={t.onPress}
            onFocus={t.onFocus}
            onBlur={t.onBlur}
            style={hoverTransition()}
            class={`size-11 items-center justify-center rounded-lg hover:bg-sidebar-accent/60 ${lit() ? "bg-sidebar-accent" : ""} ${p().offline ? "opacity-60" : ""} ${FOCUS_RING_SIDEBAR}`}
          >
            <Monogram name={p().name} size={32} />
            <If when={p().needsYou > 0}>
              <View class="absolute right-0.5 top-0.5">
                <Badge onSidebar dot tone="signal" />
              </View>
            </If>
            <If when={p().pinned}>
              <View class="absolute bottom-1 right-1 size-1.5 rounded-full bg-sidebar-foreground" />
            </If>
          </View>
        </Tipped>
      )}
    >
      <PopoverTitle>{p().name}</PopoverTitle>
      <Text class="text-xs text-muted-foreground">
        {[p().machineName, projectState(p())].filter(Boolean).join(" · ")}
      </Text>
      <RailShow project={p()} />
      <Each of={p().rows} key={(r: BoardRow) => r.key}>
        {(row) => <RailAgent row={row()} project={p()} />}
      </Each>
    </Popover>
  );
}

/** The rail: one tile per project in the board's order, in a column that scrolls when there are many. */
function Rail() {
  return (
    <Scroll class="min-h-0 flex-1" contentClass="items-center gap-2 py-1" accessibilityLabel="Projects">
      <Each of={board().projects} key={(p: BoardProject) => p.key}>
        {(project) => <RailTile project={project()} />}
      </Each>
    </Scroll>
  );
}

/**
 * Fold and unfold are one control in one place, the top of the sidebar, in the rail too. It is offered only while the
 * window is wide enough to show either state: a compact window forces the rail.
 */
function CollapseButton() {
  return (
    <IconButton
      onSidebar
      icon="panel-left"
      label={rail() ? "Expand sidebar" : "Collapse sidebar"}
      shortcut={keyLabel("sidebar")}
      onPress={() => setSidebarCollapsed(!rail())}
    />
  );
}

/** Tells a screen reader how many agents need the person whenever that number changes, not on the first look. */
function announceNeedsYou() {
  let before: number | undefined;
  effect(() => {
    const n = board().counts.needsYou;
    if (before !== undefined && n !== before)
      announce(n === 0 ? "Nothing needs you" : n === 1 ? "1 agent needs you" : `${n} agents need you`);
    before = n;
  });
}

/** Fills its panel: the width is the user's (`App.tsx`), the edge line is the panel group's handle. */
export function Sidebar() {
  announceNeedsYou();
  const needs = () => board().counts.needsYou;
  const empty = () => items().length === 0;
  return (
    <View class="size-full gap-4 bg-sidebar px-3 py-4">
      <View class={`h-10 flex-row items-center ${rail() ? "justify-center" : "justify-between pl-3"}`}>
        <If when={!rail() || compact()}>
          <View class="flex-row items-center gap-2">
            <View class="size-5 items-center justify-center rounded-md bg-sidebar-accent">
              <Icon name="monitor" size={14} tone="muted-foreground" />
            </View>
            <If when={!rail()}>
              <Text class="text-sm font-medium text-sidebar-foreground">Herdr</Text>
            </If>
          </View>
        </If>
        <If when={!compact()}>
          <CollapseButton />
        </If>
      </View>
      <View class="gap-1">
        <View class="pb-2">
          <NavRow icon="plus" label="New agent session" shortcut={keyLabel("newAgent")} onPress={() => newSession()}>
            <If when={!snug()}>
              <Kbd keys={keyLabel("newAgent")} tone="sidebar" />
            </If>
          </NavRow>
        </View>
        <NavRow
          icon="list"
          label="Board"
          name={needs() > 0 ? `Board, ${needs()} need you` : "Board"}
          shortcut={keyLabel("board")}
          selected={focused() === BOARD}
          onPress={() => void showBoard()}
        >
          <Badge onSidebar count={needs()} />
        </NavRow>
      </View>
      <If when={rail()}>
        <View class="gap-0.5">
          <Each of={statuses().filter((m) => m.state !== "online")} key={(m: MachineStatus) => m.id}>
            {(m) => <MachineGlyph status={m()} />}
          </Each>
        </View>
      </If>
      <If when={!rail()}>
        <SearchField
          value={query()}
          onChange={(v) => query.set(v)}
          placeholder="Search projects"
          inputRef={(ref) => (sidebarSearch.focus = () => ref.focus())}
        />
      </If>
      <If when={rail()} else={<Tree />}>
        <Rail />
      </If>
      <If when={!rail() && empty()}>
        <Text class="px-3 text-xs text-muted-foreground">
          {query().trim() ? "No project or agent matches" : board().statusLine}
        </Text>
      </If>
      <If when={!rail()}>
        <SidebarFooter />
      </If>
      <NavRow
        icon="sliders"
        label="Settings"
        shortcut={keyLabel("settings")}
        selected={settingsPage() !== null}
        onPress={() => openSettings()}
      />
    </View>
  );
}
