import { announce, computed, effect, keymap, List, Scroll, signal, Text, View } from "nsh";
import type { JSX } from "nsh";
import { Button } from "nsh/base";
import { Herdr } from "herdr-desktop/native";
import type { BoardProject, BoardRow, MachineStatus } from "herdr-desktop/native";
import { machinesOpen, newSession, settingsOpen, sidebarSearch } from "../lib/actions";
import { BOARD, focused, rowKeyOf, showBoard } from "../lib/dock";
import { board, projectOf, revision, rowOf, started } from "../lib/herdr";
import { linkGlyph, linkText } from "../lib/machine-state";
import { ofKind } from "../lib/list-item";
import { hoverTransition } from "../lib/motion";
import { openAgent } from "../lib/open-agent";
import { isSelected, rangeTo, toggle } from "../lib/selection";
import { sidebarCollapsed } from "../lib/settings";
import { keyLabel } from "../lib/shortcuts";
import { ageText, foldedProjects, moreOpen, projectFolder, projectLabel, projectState, rowLabel, type SidebarItem, sidebarItems, toggleMore, toggleProject } from "../lib/sidebar";
import { ActionMenu, Badge, Btn, Clipped, compact, FOCUS_RING_SIDEBAR, Icon, type IconName, IconButton, Kbd, NUM, Popover, PopoverTitle, rail, SearchField, snug, Tipped, usePopover } from "./kit";
import { PickBox } from "./pick-box";
import { Monogram, StateChips } from "./project-parts";
import { StatusGlyph } from "./status-glyph";

/** Hover and the open tab are a quiet fill, nothing else. The focus ring is inset: see `FOCUS_RING_SIDEBAR`. */
const ROW = `rounded-md hover:bg-sidebar-accent/60 selected:bg-sidebar-accent ${FOCUS_RING_SIDEBAR}`;

const query = signal("");

/** Every machine's link. Empty until the engine runs: this computed is built when the module loads, before `Herdr.configure`. */
const statuses = computed<MachineStatus[]>(() => {
  if (!started()) return [];
  revision();
  return Herdr.machineStatuses();
});

const items = computed(() => sidebarItems(board(), statuses(), query(), foldedProjects(), moreOpen()));
const rowKeys = computed(() => items().flatMap((i) => (i.kind === "row" ? [i.row.key] : [])));

/** The agent whose tab is the one being worked in: its row is lit, and in the rail so is its project's tile. */
const openRow = computed(() => {
  const key = rowKeyOf(focused());
  return key === null ? undefined : rowOf(key);
});

const isOpen = (row: BoardRow) => openRow()?.key === row.key;
const nameOf = (projectKey: string) => projectOf(projectKey)?.name ?? "";

/** One line of the top group: icon, label, then `children` (a count, a keycap) at the far end; in the rail the icon alone. */
function NavRow(props: { icon: IconName; label: string; name?: string; shortcut?: string; selected?: boolean; onPress: () => void; mark?: JSX.Element; children?: JSX.Element }) {
  return (
    <Tipped label={props.label} shortcut={props.shortcut} class={rail() ? "items-center" : undefined}>
      <Button
        onPress={props.onPress}
        selected={props.selected}
        accessibilityLabel={props.name ?? props.label}
        style={hoverTransition()}
        class={`h-7 flex-row items-center ${ROW} ${rail() ? "w-10 justify-center" : "justify-between px-2"}`}
      >
        <View class="flex-row items-center gap-2.5">
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
      <Button onPress={() => machinesOpen.set(true)} accessibilityLabel={label()} style={hoverTransition()} class={`h-7 w-10 items-center justify-center ${ROW}`}>
        <StatusGlyph status={linkGlyph(props.status.state)} />
      </Button>
    </Tipped>
  );
}

/**
 * A machine, as the quiet header of its projects: its name, how many of its agents need you, and, when it is not
 * connected, why and what happens next (with `Fix` when it needs the person). Shown when there is more than one machine
 * or one has a problem.
 */
function Host(props: { item: () => Extract<SidebarItem, { kind: "host" }> }) {
  const s = () => props.item().status;
  const line = () => linkText(s());
  const label = () => `${s().name}, ${line()}`;
  return (
    <View class="mt-2 gap-0.5">
      <Button onPress={() => machinesOpen.set(true)} accessibilityLabel={label()} style={hoverTransition()} class={`min-h-7 flex-row items-center gap-2 px-2 py-0.5 ${ROW}`}>
        <StatusGlyph status={linkGlyph(s().state)} size={12} />
        <Clipped class="min-w-0 flex-1 text-xs font-medium text-muted-foreground">{s().name}</Clipped>
        <Badge onSidebar tone="signal" count={s().needsYou} />
      </Button>
      <If when={s().state !== "online"}>
        <Clipped lines={2} class="px-2 text-xs text-muted-foreground">
          {line()}
        </Clipped>
      </If>
      <If when={s().state === "attention"}>
        <View class="items-start px-2 pb-1">
          <Btn small variant="outline" label="Fix" name={`Fix ${s().name}`} onPress={() => machinesOpen.set(true)} />
        </View>
      </If>
    </View>
  );
}

/** What a project's menu offers: pin it, start a chat in it, fold it. */
function projectEntries(project: BoardProject) {
  return [
    { label: project.pinned ? "Unpin" : "Pin to the top", onSelect: () => Herdr.pinProject(project.key, !project.pinned) },
    { label: "New agent session here…", onSelect: () => newSession({ machine: project.machine, folder: projectFolder(project) }), disabled: project.offline },
  ];
}

/**
 * A project: fold button, name, its state as shape and number chips, and (on hover or focus, over the chips) its menu.
 * The row reads its item and holds no state, because the list recycles cells.
 */
function Project(props: { item: () => Extract<SidebarItem, { kind: "project" }> }) {
  const p = () => props.item().project;
  return (
    <View class={`group mt-1 ${p().offline ? "opacity-60" : ""}`}>
      <View
        role="button"
        onPress={() => toggleProject(p().key)}
        accessibilityLabel={projectLabel(p())}
        accessibilityState={{ expanded: !props.item().folded }}
        style={hoverTransition()}
        class={`min-h-8 flex-row items-center gap-1.5 px-1.5 py-1 ${ROW}`}
      >
        <Icon name={props.item().folded ? "chevron-right" : "chevron-down"} size={12} tone="muted-foreground" />
        <Clipped class="min-w-0 flex-1 text-sm font-medium text-sidebar-foreground">{p().name}</Clipped>
        <If when={p().pinned}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" class="size-1.5 rounded-full bg-sidebar-foreground" />
        </If>
        <StateChips project={p()} onSidebar />
      </View>
      <View class="absolute bottom-0 right-0 top-0 justify-center bg-sidebar pl-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <ActionMenu label={`Options for ${p().name}`} entries={projectEntries(p())} />
      </View>
    </View>
  );
}

/** A checkout of a project that has several: the worktree a group of agents works in. */
function Checkout(props: { item: () => Extract<SidebarItem, { kind: "checkout" }> }) {
  const c = () => props.item().checkout;
  return (
    <View class="flex-row items-center gap-1.5 pl-5 pr-2 pt-1" accessibilityLabel={c().linked ? `${c().name}, worktree` : `${c().name}, main checkout`}>
      <Clipped class="min-w-0 shrink text-xs text-muted-foreground">{c().name}</Clipped>
      <Text class="text-xs text-muted-foreground">{c().linked ? "worktree" : "main"}</Text>
    </View>
  );
}

/**
 * Space picks the focused agent for a bulk action and Shift+Space picks the range from the last pick, the keyboard form
 * of the checkbox. The keys are bound only while this row has the focus (a held binding is released with the row), and
 * they read the row at the moment of the press, because a recycled cell shows other agents over time.
 */
function useRowKeys(row: () => BoardRow) {
  const focus = signal(false);
  effect(() => {
    if (!focus()) return;
    return keymap.bind({
      space: () => toggle(row().key),
      "shift+space": () => rangeTo(row().key, rowKeys()),
    });
  });
  return { onFocus: () => focus.set(true), onBlur: () => focus.set(false) };
}

/** An agent in two lines: its state as a shape, its name and how long, and under it what it is (the agent, chat or terminal). */
function Agent(props: { item: () => Extract<SidebarItem, { kind: "row" }> }) {
  const row = () => props.item().row;
  const keys = useRowKeys(row);
  const sub = () => [row().agent, row().session ? "chat" : "terminal", row().offline ? "offline" : ""].filter(Boolean).join(" · ");
  return (
    <View class={`group flex-row items-center ${props.item().nested ? "pl-3" : ""}`}>
      <View class={`pl-1 ${isSelected(row().key) ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
        <PickBox rowKey={row().key} name={row().name} order={rowKeys} />
      </View>
      <View
        role="button"
        onPress={() => void openAgent(row())}
        accessibilityState={{ selected: isOpen(row()) }}
        accessibilityLabel={rowLabel(row(), nameOf(props.item().project))}
        onFocus={keys.onFocus}
        onBlur={keys.onBlur}
        style={hoverTransition()}
        class={`min-h-10 min-w-0 flex-1 flex-row items-center gap-2.5 px-2 py-1 ${ROW} ${row().offline ? "opacity-60" : ""}`}
      >
        <StatusGlyph status={row().status} />
        <View class="min-w-0 flex-1">
          <View class="flex-row items-center gap-2">
            <Clipped class="min-w-0 flex-1 text-sm text-sidebar-foreground">{row().name}</Clipped>
            <Text style={NUM} class="text-xs text-muted-foreground">
              {ageText(row().sinceSecs)}
            </Text>
          </View>
          <Clipped class="text-xs text-muted-foreground">{sub()}</Clipped>
        </View>
      </View>
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
      class={`h-7 justify-center pl-8 pr-2 ${ROW}`}
    >
      <Text class="text-xs text-muted-foreground">{text()}</Text>
    </View>
  );
}

/** The tree: machines, projects, checkouts, agents. Rows are recycled, so each reads its item and holds nothing of its own. */
function Tree() {
  return (
    <List each={items()} keyExtractor={(i: SidebarItem) => i.key} estimatedItemSize={44} class="min-h-0 flex-1" contentClass="gap-0.5" accessibilityLabel="Projects and agents">
      {(item) => {
        const host = ofKind(item, "host");
        const project = ofKind(item, "project");
        const checkout = ofKind(item, "checkout");
        const row = ofKind(item, "row");
        const more = ofKind(item, "more");
        return (
          <If
            when={item().kind === "host"}
            else={
              <If
                when={item().kind === "project"}
                else={
                  <If when={item().kind === "checkout"} else={<If when={item().kind === "row"} else={<More item={more} />}><Agent item={row} /></If>}>
                    <Checkout item={checkout} />
                  </If>
                }
              >
                <Project item={project} />
              </If>
            }
          >
            <Host item={host} />
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
      class={`min-h-9 flex-row items-center gap-2.5 rounded-md px-2 py-1 hover:bg-accent ${FOCUS_RING_SIDEBAR} ${props.row.offline ? "opacity-60" : ""}`}
    >
      <StatusGlyph status={props.row.status} />
      <Clipped class="min-w-0 flex-1 text-sm text-foreground">{props.row.name}</Clipped>
      <Text style={NUM} class="text-xs text-muted-foreground">
        {ageText(props.row.sinceSecs)}
      </Text>
    </View>
  );
}

/**
 * A project in the rail: a tile with its first letters and, in a corner, what it is doing: the signal count with the
 * filled disc when something needs you, else the quiet half ring while something works. Pinned projects carry a small
 * dot, the project being worked in is lit. A press opens a popover with the project's agents (the sidebar cannot widen
 * in a narrow window); its name and state are the tooltip and the accessible name.
 */
function RailTile(props: { project: BoardProject }) {
  const p = () => props.project;
  const lit = () => openRow()?.project === p().key;
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
            class={`size-10 items-center justify-center rounded-lg hover:bg-sidebar-accent/60 ${lit() ? "bg-sidebar-accent" : ""} ${p().offline ? "opacity-60" : ""} ${FOCUS_RING_SIDEBAR}`}
          >
            <Monogram name={p().name} size={32} />
            <If when={p().needsYou > 0}>
              <View class="absolute -right-0.5 -top-0.5 flex-row items-center gap-0.5 rounded-full bg-sidebar-primary px-1 py-px">
                <Text style={NUM} class="text-xs font-semibold text-sidebar-primary-foreground">
                  {`${p().needsYou}`}
                </Text>
              </View>
            </If>
            <If when={p().needsYou === 0 && p().working > 0}>
              <View class="absolute -right-0.5 -top-0.5 rounded-full bg-sidebar p-0.5">
                <StatusGlyph status="working" size={12} />
              </View>
            </If>
            <If when={p().pinned}>
              <View class="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-sidebar-foreground" />
            </If>
          </View>
        </Tipped>
      )}
    >
      <PopoverTitle>{p().name}</PopoverTitle>
      <Text class="text-xs text-muted-foreground">{[p().machineName, projectState(p())].filter(Boolean).join(" · ")}</Text>
      <Each of={p().rows} key={(r: BoardRow) => r.key}>
        {(row) => <RailAgent row={row()} project={p()} />}
      </Each>
    </Popover>
  );
}

/** The rail: one tile per project in the board's order, in a column that scrolls when there are many. */
function Rail() {
  return (
    <Scroll class="min-h-0 flex-1" contentClass="items-center gap-1.5 py-1" accessibilityLabel="Projects">
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
    <IconButton onSidebar icon="panel-left" label={rail() ? "Expand sidebar" : "Collapse sidebar"} shortcut={keyLabel("sidebar")} onPress={() => sidebarCollapsed.set(!rail())} />
  );
}

/** Tells a screen reader how many agents need the person whenever that number changes, not on the first look. */
function announceNeedsYou() {
  let before: number | undefined;
  effect(() => {
    const n = board().counts.needsYou;
    if (before !== undefined && n !== before) announce(n === 0 ? "Nothing needs you" : n === 1 ? "1 agent needs you" : `${n} agents need you`);
    before = n;
  });
}

/** Fills its panel: the width is the user's (`App.tsx`), the edge line is the panel group's handle. */
export function Sidebar() {
  announceNeedsYou();
  const needs = () => board().counts.needsYou;
  const empty = () => items().length === 0;
  return (
    <View class="size-full gap-3 bg-sidebar px-2 py-3">
      <View class={`h-8 flex-row items-center ${rail() ? "justify-center" : "justify-between pl-2"}`}>
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
      <View class="gap-0.5">
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
          mark={
            <If when={needs() > 0}>
              <View class="absolute right-1 top-0.5">
                <Badge onSidebar dot tone="signal" />
              </View>
            </If>
          }
        >
          <Badge onSidebar count={needs()} tone="signal" />
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
        <SearchField value={query()} onChange={(v) => query.set(v)} placeholder="Search projects" inputRef={(ref) => (sidebarSearch.focus = () => ref.focus())} />
      </If>
      <If when={rail()} else={<Tree />}>
        <Rail />
      </If>
      <If when={!rail() && empty()}>
        <Text class="px-2 text-xs text-muted-foreground">{query().trim() ? "No project or agent matches" : board().statusLine}</Text>
      </If>
      <NavRow icon="sliders" label="Settings" shortcut={keyLabel("settings")} onPress={() => settingsOpen.set(true)} />
    </View>
  );
}
