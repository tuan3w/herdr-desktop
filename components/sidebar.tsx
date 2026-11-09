import { Herdr } from "herdr-desktop/native";
import { announce, computed, effect, keymap, List, Scroll, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { BoardProject, BoardRow, MachineStatus } from "herdr-desktop/native";
import type { InputRef, ListRef } from "nsh/types";

import { useRowKeys } from "#components/pick-box";
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
  NUM,
  Popover,
  PopoverTitle,
  rail,
  SearchField,
  Tipped,
  usePopover,
  useTriggerFocus,
} from "#kit";
import { newSession, openSettings, settingsPage, sidebarSearch } from "#lib/actions";
import { checkoutsOf, openChanges } from "#lib/changes";
import { controls } from "#lib/chrome";
import { BOARD, context, focused, layout, panelsOf, rowKeyOf, showBoard } from "#lib/dock";
import { actionSlot, estimate, machineFits } from "#lib/header-fit";
import { board, projectOf, revision, rowOf, started } from "#lib/herdr";
import { BAR, ROW } from "#lib/layout";
import { ofKind } from "#lib/list-item";
import { linkGlyph, linkText } from "#lib/machine-state";
import { hoverTransition, moveTransition } from "#lib/motion";
import { openProject } from "#lib/nav";
import { openAgent } from "#lib/open-agent";
import { isSelected, rangeTo, toggle } from "#lib/selection";
import { largeTargets, setSidebarCollapsed } from "#lib/settings";
import { keyLabel, keyText, modHeld, MOVE_DOWN_KEY, MOVE_UP_KEY } from "#lib/shortcuts";
import {
  ageText,
  foldedProjects,
  foldedSections,
  keepItems,
  moreOpen,
  moveProject,
  type ProjectMove,
  projectFolder,
  projectLabel,
  projectOrder,
  projectState,
  quietOpen,
  rowLabel,
  type SidebarItem,
  sidebarItems,
  toggleMore,
  toggleProject,
  toggleQuiet,
  toggleSection,
  treeOffset,
} from "#lib/sidebar";
import { openAgentBeside } from "#lib/split";
import { stateWord } from "#lib/status";
import { lookUpBranches } from "#lib/worktrees";

/** Hover and the open tab are a quiet fill, nothing else. The focus ring is inset: see `FOCUS_RING_SIDEBAR`. */
const FILL = `rounded-md hover:bg-sidebar-accent/40 selected:bg-sidebar-accent ${FOCUS_RING_SIDEBAR}`;

/**
 * What a cut title fades into (`Clipped` `fade`): each fill its row can have, laid in order: the sidebar, the row's hover
 * tint and, for the open one, its selected fill. Same tokens as `ROW_FILL`, so the fade and the fill are one colour.
 */
const FADE = "from-sidebar/0 to-sidebar";
const FADE_HOVER = "from-sidebar-accent/0 to-sidebar-accent/40 opacity-0 group-hover/row:opacity-100";
const FADE_OPEN = "from-sidebar-accent/0 to-sidebar-accent";

/** The same three fills as plain colour, for the backing of the `...` over a row's right end (`Agent`), in the same order. */
const BACK = "bg-sidebar";
const BACK_HOVER = "bg-sidebar-accent/40 opacity-0 group-hover/row:opacity-100";
const BACK_OPEN = "bg-sidebar-accent";

/** An agent's fill follows its row (`group/row`), which holds the line and the `...` over its edge. */
const ROW_FILL = `rounded-md group-hover/row:bg-sidebar-accent/40 selected:bg-sidebar-accent ${FOCUS_RING_SIDEBAR}`;

const query = signal("");
/** The search field shows on demand: the search button or the sidebar shortcut opens it, a query keeps it. */
const searchOpen = signal(false);
const searchShown = () => !rail() && (searchOpen() || query() !== "");
let searchField: InputRef | undefined;
let focusOnMount = false;

/** Opens the search field and puts the keyboard in it; a field that is not mounted yet takes the focus when it is. */
function openSearch() {
  if (searchShown() && searchField) {
    searchField.focus();
    return;
  }
  focusOnMount = true;
  searchOpen.set(true);
}

/** Closing forgets the query too: a hidden filter would leave the list narrowed with nothing on screen saying why. */
function toggleSearch() {
  if (!searchShown()) return openSearch();
  searchOpen.set(false);
  query.set("");
}

/** Every machine's link. Empty until the engine runs: this computed is built when the module loads, before `Herdr.configure`. */
const statuses = computed<MachineStatus[]>(() => {
  if (!started()) return [];
  revision();
  return Herdr.machineStatuses();
});

/** The agents open in a tab of the workspace shown, and the one worked in: their projects are never quiet. */
const openKeys = computed(() => {
  const keys = panelsOf(layout()).flatMap((panel) => rowKeyOf(panel) ?? []);
  const here = rowKeyOf(focused());
  return here === null ? keys : [...keys, here];
});

let shown: SidebarItem[] = [];
const items = computed(
  () =>
    (shown = keepItems(
      shown,
      sidebarItems(board(), statuses(), {
        query: query(),
        folds: foldedProjects(),
        opened: moreOpen(),
        sections: foldedSections(),
        quiet: quietOpen(),
        order: projectOrder(),
        open: openKeys(),
      }),
    )),
);
const rowKeys = computed(() => items().flatMap((i) => (i.kind === "row" ? [i.row.key] : [])));

/** The agent whose tab is the one being worked in: its row is lit, and in the rail so is its project's tile. */
const openRow = computed(() => {
  const key = rowKeyOf(focused());
  return key === null ? undefined : rowOf(key);
});

const isOpen = (row: BoardRow) => openRow()?.key === row.key;
const nameOf = (projectKey: string) => projectOf(projectKey)?.name ?? "";

/**
 * One line of the top group: icon and label; in the rail the icon alone. `tip` is the bubble's text when the label is a
 * short form (`New session` shows, `New agent session` is the tip and the spoken name).
 */
function NavRow(props: {
  icon: IconName;
  label: string;
  name?: string;
  tip?: string;
  shortcut?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Tipped label={props.tip ?? props.label} shortcut={props.shortcut} class={rail() ? "items-center" : undefined}>
      <Button
        onPress={props.onPress}
        selected={props.selected}
        accessibilityLabel={props.name ?? props.label}
        style={hoverTransition()}
        class={`flex-row items-center gap-3 ${FILL} ${rail() ? "size-11 justify-center" : ROW.nav.class}`}
      >
        <Icon name={props.icon} tone={props.selected ? "sidebar-foreground" : "muted-foreground"} />
        <If when={!rail()}>
          <Text class="text-sm text-sidebar-foreground">{props.label}</Text>
        </If>
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

/** `Open to the side`: the agent's view in a group beside the focused tab (the project menu opens its first agent). */
const sideEntry = (row: BoardRow | undefined, offline: boolean) => ({
  label: "Open to the side",
  accelerator: "S",
  onSelect: () => {
    if (row) void openAgentBeside(row);
  },
  disabled: offline || !row,
});

/**
 * A row's menu (and right-click): show it beside, pick it for a bulk action, copy. Picking lives here, not as a box on the
 * row (owner, 2026-11-09, on a column of boxes cutting every title: "not like this, maybe just hide in menu"); mod+press
 * and Space pick from the row too, Shift+press and Shift+Space a range.
 */
const rowEntries = (row: BoardRow) => [
  sideEntry(row, row.offline),
  {
    label: isSelected(row.key) ? "Unpick" : "Pick for a bulk action",
    accelerator: "P",
    onSelect: () => toggle(row.key),
  },
  ...copyEntries("Name", row.name, "Folder", row.cwd),
];

/** `Open project`: the project's page; the header's press folds, so this is where the page is reached. */
const openEntry = (project: BoardProject) => ({
  label: "Open project",
  accelerator: "O",
  onSelect: () => openProject(project.key),
});

type ProjectItem = Extract<SidebarItem, { kind: "project" }>;

/** Moves a project in its section's order (`moveProject`) and says so; a move with no neighbour that way does nothing. */
function move(item: ProjectItem, to: ProjectMove) {
  const before = projectOrder();
  const next = moveProject(board(), before, {
    section: item.section,
    key: item.project.key,
    above: item.above,
    below: item.below,
    to,
  });
  if (next === before) return;
  projectOrder.set(next);
  announce(`Moved ${item.project.name} ${to === "top" ? "to the top" : to}`);
}

/**
 * What a project's menu offers: show its tabs, pin it, move it in its section, start a chat in it, review what its agents
 * changed. A move that has nowhere to go is disabled, never hidden, so the menu keeps its shape.
 */
function projectEntries(item: ProjectItem) {
  const project = item.project;
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
    sideEntry(project.rows[0], project.rows.length === 0),
    {
      label: project.pinned ? "Unpin" : "Pin to the top",
      accelerator: "P",
      onSelect: () => Herdr.pinProject(project.key, !project.pinned),
    },
    {
      label: "Move up",
      shortcut: keyText(MOVE_UP_KEY),
      onSelect: () => move(item, "up"),
      disabled: item.above === null,
    },
    {
      label: "Move down",
      shortcut: keyText(MOVE_DOWN_KEY),
      onSelect: () => move(item, "down"),
      disabled: item.below === null,
    },
    { label: "Move to top", accelerator: "T", onSelect: () => move(item, "top"), disabled: item.above === null },
    {
      label: "New agent session here…",
      accelerator: "N",
      onSelect: () => newSession({ machine: project.machine, folder: projectFolder(project) }),
      disabled: project.offline,
    },
    {
      label: "New worktree…",
      accelerator: "W",
      onSelect: () => newSession({ machine: project.machine, folder: projectFolder(project), worktree: true }),
      // Only a repository has worktrees: a project that is a label or a plain folder has no checkout.
      disabled: project.offline || project.checkouts.length === 0,
    },
    ...changesEntries(project),
    ...copyEntries("Project name", project.name, "Folder", projectFolder(project)),
  ];
}

/** The header button's left padding (`pl-3`), which `machineFits` takes off the line. */
const HEADER_PAD = 12;

/** The header's gap (`gap-2`) before a folder's end: with the end's width, what the machine label cannot use. */
const TAIL_GAP = 8;

/** What a folded header's right end holds (the count and the signal dot, with their gap): the one number here that is not measured. */
const FOLDED_MARK = 40;

/** A text laid out once with no clamp, so a width is the text's own and not a guess: `{ text, width }` of the last layout. */
function useNatural() {
  const seen = signal({ text: "", width: 0 });
  return {
    /** The width of `text` when it has been measured, else `undefined` (the caller falls back to an estimate). */
    of: (text: string) => (seen().text === text && seen().width > 0 ? seen().width : undefined),
    onTextLayout: (text: string) => (e: { lines: { bounds: { size: { width: number } } }[] }) =>
      seen.set({ text, width: Math.ceil(e.lines.reduce((sum, l) => sum + l.bounds.size.width, 0)) }),
  };
}

/**
 * A project: one quiet line, the name with a small chevron right after it, in `Pinned` its machine (muted, amber when
 * stale; none for this computer: a machine's section names it), the end of its folder in mono when another project of its
 * section has its name, while folded how many of its agents wait (the signal dot and the number) and, on hover or focus
 * over it, a plus (a new session in its folder) and its menu at the free right edge. The whole line is one button that
 * folds it: no fill on hover, because the name and the chevron are one thing; `Open project` is the menu's first entry.
 * The machine is whole or left out (`machineFits`, from measured widths); only a name that is really too long fades. A pin
 * is said in the bubble and the accessible name, not by a mark. While it has the focus, `mod+shift+up`/`down` move it in
 * its section. Its text starts on the agents' titles. The row reads its item and holds no state, because the list
 * recycles cells.
 */
export function Project(props: { item: () => ProjectItem }) {
  const p = () => props.item().project;
  // The line's width and the texts' own widths; the slot at the right edge is held back whether or not the actions
  // show, so nothing reflows on hover.
  const width = signal(0);
  const nameW = useNatural();
  const machineW = useNatural();
  const tailW = useNatural();
  const menuOpen = signal(false);
  const focus = signal(false);
  // Bound only while the header has the focus, and read at the press: a recycled cell shows other projects over time.
  effect(() => {
    if (!focus()) return;
    return keymap.bind({
      [MOVE_UP_KEY]: () => move(props.item(), "up"),
      [MOVE_DOWN_KEY]: () => move(props.item(), "down"),
    });
  });
  const slot = () => actionSlot({ plus: true, large: largeTargets() });
  const machine = () => props.item().machine ?? "";
  const tail = () => props.item().tail ?? "";
  const tailRoom = () => (tail() === "" ? 0 : (tailW.of(tail()) ?? estimate(tail().length, "machine")) + TAIL_GAP);
  const showMachine = () =>
    machine() !== "" &&
    (width() === 0 ||
      machineFits({
        name: nameW.of(p().name) ?? estimate(p().name.length, "name"),
        machine: machineW.of(machine()) ?? estimate(machine().length, "machine"),
        room: width() - HEADER_PAD - slot() - tailRoom() - (props.item().folded ? FOLDED_MARK : 0),
      }));
  return (
    <View role="group" accessibilityLabel={projectLabel(p())} class={`group mt-2 ${p().offline ? "opacity-60" : ""}`}>
      <Tipped label={[p().name, machine(), tail(), p().pinned ? "pinned" : ""].filter(Boolean).join(" · ")}>
        <View
          role="button"
          onPress={() => toggleProject(p().key)}
          onContextMenu={copyMenu(() => [
            openEntry(p()),
            ...copyEntries("Project name", p().name, "Folder", projectFolder(p())),
          ])}
          onFocus={() => focus.set(true)}
          onBlur={() => focus.set(false)}
          onLayout={({ bounds }) => width.set(bounds.size.width)}
          accessibilityLabel={`${props.item().folded ? "Unfold" : "Fold"} ${p().name}`}
          accessibilityState={{ expanded: !props.item().folded }}
          style={{ paddingRight: slot() }}
          class={`flex-row items-center gap-2 min-h-7 pl-3 rounded-md ${FOCUS_RING_SIDEBAR}`}
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            class="pointer-events-none absolute left-0 top-0 opacity-0"
          >
            <Text class="text-sm font-medium" onTextLayout={nameW.onTextLayout(p().name)}>
              {p().name}
            </Text>
            <Text class="text-xs" onTextLayout={machineW.onTextLayout(machine())}>
              {machine()}
            </Text>
            <Text class="font-mono text-xs" onTextLayout={tailW.onTextLayout(tail())}>
              {tail()}
            </Text>
          </View>
          <Clipped fade={[FADE]} boxClass="min-w-0 shrink" class="text-sm font-medium text-muted-foreground">
            {p().name}
          </Clipped>
          <View
            style={moveTransition()}
            class={props.item().folded ? "" : "rotate-90"}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Icon name="chevron-right" size={12} tone="muted-foreground" />
          </View>
          <If when={showMachine()}>
            <Text
              style={{ numberOfLines: 1 }}
              class={`shrink-0 text-xs ${props.item().stale ? "text-warning" : "text-muted-foreground"}`}
            >
              {machine()}
            </Text>
          </If>
          <If when={tail() !== ""}>
            <Clipped fade={[FADE]} boxClass="min-w-0 shrink" class="font-mono text-xs text-muted-foreground">
              {tail()}
            </Clipped>
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
          entries={projectEntries(props.item())}
          onOpenChange={(open) => menuOpen.set(open)}
        />
      </View>
    </View>
  );
}

/**
 * A section's label (`Pinned`, `This computer`, another machine), one button that folds it, like a project header. A
 * machine says it is one: the computer icon and its name in the sidebar's text colour (projects stay muted under it), with
 * a hairline above every section but the first, so a machine never reads as another project name (owner, 2026-11-09,
 * chosen from a rendered prototype: "I don't know if something is a machine or just a project name"). Its link shows as a
 * word only while it is not live (amber, like a stale machine's name), never a mark for live. Folded, it says how many of
 * its agents wait (the signal dot and the number), as a folded project does.
 */
function Section(props: { item: () => Extract<SidebarItem, { kind: "section" }> }) {
  const it = props.item;
  const waiting = () => (it().folded && it().needsYou > 0 ? it().needsYou : 0);
  const machine = () => it().section !== "pinned";
  const first = () => items().find((i) => i.kind === "section")?.key === it().key;
  return (
    <View class={first() ? "mt-4" : "mt-4 border-t border-sidebar-border pt-3"}>
      <View
        role="button"
        onPress={() => toggleSection(it().section)}
        accessibilityLabel={[
          `${it().folded ? "Unfold" : "Fold"} ${it().label}`,
          it().state ?? "",
          waiting() === 0 ? "" : waiting() === 1 ? "1 needs you" : `${waiting()} need you`,
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityState={{ expanded: !it().folded }}
        class={`min-h-7 flex-row items-center gap-2 px-3 rounded-md ${FOCUS_RING_SIDEBAR}`}
      >
        <If when={machine()}>
          <Icon name="monitor" size={14} tone="muted-foreground" />
        </If>
        <Clipped
          fade={[FADE]}
          boxClass="min-w-0 shrink"
          class={`text-xs font-medium ${machine() ? "text-sidebar-foreground" : "text-muted-foreground"}`}
        >
          {it().label}
        </Clipped>
        <View
          style={moveTransition()}
          class={it().folded ? "" : "rotate-90"}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Icon name="chevron-right" size={12} tone="muted-foreground" />
        </View>
        <If when={it().state !== null}>
          <Text style={{ numberOfLines: 1 }} class="shrink-0 text-xs text-warning">
            {it().state ?? ""}
          </Text>
        </If>
        <If when={waiting() > 0}>
          <View
            class="ml-auto flex-row items-center gap-2 pl-2"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Badge dot tone="signal" onSidebar />
            <Text style={NUM} class="text-xs text-muted-foreground">{`${waiting()}`}</Text>
          </View>
        </If>
      </View>
    </View>
  );
}

/**
 * `3 quiet projects ›` at the end of a section: its projects where nothing works, waits, is to review or open, behind one
 * line that lists them under it in place (the line stays where it is, its chevron turns). Never hides a waiting agent: a
 * project with one is not quiet.
 */
function QuietLine(props: { item: () => Extract<SidebarItem, { kind: "quiet" }> }) {
  const it = props.item;
  const text = () => `${it().count} quiet ${it().count === 1 ? "project" : "projects"}`;
  return (
    <View
      role="button"
      onPress={() => toggleQuiet(it().section)}
      accessibilityLabel={`${text()} in ${it().label}`}
      accessibilityState={{ expanded: it().open }}
      style={hoverTransition()}
      class={`mt-2 flex-row items-center gap-2 ${ROW.more.class} ${FILL}`}
    >
      <Text class="text-xs text-muted-foreground">{text()}</Text>
      <View
        style={moveTransition()}
        class={it().open ? "rotate-90" : ""}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon name="chevron-right" size={12} tone="muted-foreground" />
      </View>
    </View>
  );
}

/**
 * A checkout of a project that has several: the worktree a group of agents works in, as one label on the agents' title
 * edge (the row's own padding). The branch, once herdr said it, is what tells two checkouts apart; until then the folder's
 * name. The spoken name keeps all three: folder, kind and branch.
 */
function Checkout(props: { item: () => Extract<SidebarItem, { kind: "checkout" }> }) {
  const c = () => props.item().checkout;
  return (
    <View
      class={`flex-row items-center ${ROW.more.class}`}
      accessibilityLabel={`${c().name}, ${c().linked ? "worktree" : "main checkout"}${c().branch ? `, branch ${c().branch}` : ""}`}
    >
      <Clipped
        fade={[FADE]}
        boxClass="min-w-0 flex-1"
        class={`text-xs text-muted-foreground ${c().branch ? "font-mono" : ""}`}
      >
        {c().branch || c().name}
      </Clipped>
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

/** What a row's hover actions do at rest: hidden, and shown while the pointer is on the row or the focus is in it. */
const ON_ROW = "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100";

/**
 * An agent in one line: its name from the row's padding (the project header's text edge) and its state as a quiet shape at
 * the right end (none while idle). A stale machine's agent is a dashed ring, no word (`rowLabel` still says `offline`); the
 * program, machine and age are in the bubble and in the accessible name. On hover or focus the `...` comes over the
 * glyph's place on a backing of the row's own fill (the glyph is covered, nothing moves). A picked agent shows a check in
 * the glyph's place: picking costs no width on any row.
 */
function Agent(props: { item: () => Extract<SidebarItem, { kind: "row" }> }) {
  const row = () => props.item().row;
  const menuOpen = signal(false);
  const backs = () => (isOpen(row()) ? [BACK, BACK_OPEN] : [BACK, BACK_HOVER]);
  return (
    <View class="group/row relative">
      <Tipped label={rowDetail(row())}>
        <AgentButton item={props.item} />
      </Tipped>
      <View class="absolute inset-y-0 right-0 flex-row">
        <View class={`w-10 items-center justify-center ${menuOpen() ? "opacity-100" : ON_ROW}`}>
          <View
            class="pointer-events-none absolute inset-0"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Each of={backs()} key="index">
              {(layer) => <View class={`absolute inset-0 rounded-r-md ${layer()}`} />}
            </Each>
          </View>
          <ActionMenu
            label={`Options for ${row().name}`}
            entries={rowEntries(row())}
            onOpenChange={(open) => menuOpen.set(open)}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * The pressable line, apart from `Agent` so `useTriggerFocus` is called inside the bubble's trigger. Its fill is the row's
 * (`group/row`), not its own, so it stays lit while the pointer is on the actions that sit over its right end. The title
 * starts on the row's padding and runs to the glyph's box, which is kept while idle so a change of state never re-cuts it;
 * the actions come over the tail on a backing of the row's own fill, so the text never moves.
 */
function AgentButton(props: { item: () => Extract<SidebarItem, { kind: "row" }> }) {
  const row = () => props.item().row;
  const keys = useRowKeys(row, rowKeys);
  const tip = useTriggerFocus();
  return (
    <View
      role="button"
      onPress={(e) => {
        if (e?.modifiers.shift) rangeTo(row().key, rowKeys());
        else if (e && modHeld(e)) toggle(row().key);
        else void openAgent(row());
      }}
      onContextMenu={copyMenu(() => rowEntries(row()))}
      accessibilityState={{ selected: isOpen(row()) }}
      accessibilityLabel={`${rowLabel(row(), nameOf(props.item().project))}${isSelected(row().key) ? ", picked" : ""}`}
      onFocus={() => {
        keys.onFocus();
        tip.onFocus?.();
      }}
      onBlur={() => {
        keys.onBlur();
        tip.onBlur?.();
      }}
      style={hoverTransition()}
      class={`min-w-0 flex-row items-center gap-2 ${ROW.agentCompact.class} ${ROW_FILL} ${row().offline ? "opacity-60" : ""}`}
    >
      <Clipped
        fade={isOpen(row()) ? [FADE, FADE_OPEN] : [FADE, FADE_HOVER]}
        boxClass="min-w-0 flex-1"
        class="text-sm text-sidebar-foreground"
      >
        {row().name}
      </Clipped>
      {/* The one signal mark of an agent that waits, in this view (`design/attention.md`, rule 4), centred where the `...`
          comes on hover, so the one replaces the other in place. */}
      <View class="size-4 items-center justify-center">
        <If
          when={isSelected(row().key)}
          else={<StatusGlyph status={row().offline ? "unknown" : row().status} id={row().key} loud />}
        >
          <Icon name="check" size={14} tone="primary" />
        </If>
      </View>
    </View>
  );
}

/** `N more idle` under a project, its text on the agents' title edge. */
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
      class={`justify-center ${ROW.more.class} ${FILL}`}
    >
      <Text class="text-xs text-muted-foreground">{text()}</Text>
    </View>
  );
}

/** The tree: sections, projects, checkouts, agents. Rows are recycled, so each reads its item and holds nothing of its own. */
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
      // The last line scrolls clear of the fade over the list's bottom edge (`Sidebar`), so the real end reads whole.
      contentClass="gap-0 pb-8"
      scrollEventThrottle={50}
      onScroll={(e) => treeOffset.set(e.offset.y)}
      accessibilityLabel="Projects and agents"
    >
      {(item) => {
        const section = ofKind(item, "section");
        const quiet = ofKind(item, "quiet");
        const project = ofKind(item, "project");
        const checkout = ofKind(item, "checkout");
        const row = ofKind(item, "row");
        const more = ofKind(item, "more");
        return (
          <If
            when={item().kind === "row"}
            else={
              <If
                when={item().kind === "project"}
                else={
                  <If
                    when={item().kind === "checkout"}
                    else={
                      <If
                        when={item().kind === "section"}
                        else={
                          <If when={item().kind === "quiet"} else={<More item={more} />}>
                            <QuietLine item={quiet} />
                          </If>
                        }
                      >
                        <Section item={section} />
                      </If>
                    }
                  >
                    <Checkout item={checkout} />
                  </If>
                }
              >
                <Project item={project} />
              </If>
            }
          >
            <Agent item={row} />
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

/**
 * Fills its panel: the width is the user's (`App.tsx`), the edge line is the panel group's handle. Its first line is the
 * window's top band (`BAR`, draggable like a title bar; macOS's traffic lights sit over its left end), holding the menu
 * where the platform lost its menu bar, search and fold at the right end. The list fades into a hairline above Settings,
 * so a row cut by the scroll position never reads as the end of the list.
 */
export function Sidebar() {
  announceNeedsYou();
  // The sidebar names a checkout by its branch, which only `worktree.list` knows: ask once per set of checkouts.
  effect(() => {
    for (const project of board().projects) untracked(() => lookUpBranches(project));
  });
  sidebarSearch.focus = openSearch;
  const needs = () => board().counts.needsYou;
  const empty = () => items().length === 0;
  const settings = () => (
    <View class="border-t border-sidebar-border pt-2">
      <NavRow
        icon="sliders"
        label="Settings"
        shortcut={keyLabel("settings")}
        selected={settingsPage() !== null}
        onPress={() => openSettings()}
      />
    </View>
  );
  return (
    <View class={`size-full min-w-0 overflow-hidden bg-sidebar px-3 pb-3 ${rail() ? "gap-2" : ""}`}>
      <If
        when={rail()}
        else={
          <View
            desktop={{ windowDrag: true }}
            style={{ height: BAR, paddingLeft: Math.max(12, controls().left) }}
            class="flex-row items-center justify-end gap-1"
          >
            <IconButton
              onSidebar
              icon="search"
              label="Search projects and agents"
              tip="Search"
              shortcut={keyLabel("focusSidebar")}
              selected={searchShown()}
              onPress={toggleSearch}
            />
            <If when={!compact()}>
              <CollapseButton />
            </If>
          </View>
        }
      >
        {/* macOS's traffic lights sit over this line; with the system title bar shown it is not drawn. */}
        <If when={controls().left > 0}>
          <View desktop={{ windowDrag: true }} style={{ height: BAR }} />
        </If>
        <If when={!compact()}>
          <View style={{ height: BAR }} class="items-center justify-center">
            <CollapseButton />
          </View>
        </If>
      </If>
      <View>
        <NavRow
          icon="plus"
          label="New session"
          name="New agent session"
          tip="New agent session"
          shortcut={keyLabel("newAgent")}
          onPress={() => newSession()}
        />
        {/* No count: the Board's chips are the one place that says how many (`design/attention.md`); the name still does. */}
        <NavRow
          icon="list"
          label="Board"
          name={needs() > 0 ? `Board, ${needs()} need you` : "Board"}
          shortcut={keyLabel("board")}
          selected={focused() === BOARD}
          onPress={() => void showBoard()}
        />
      </View>
      <If when={rail()}>
        <View class="gap-0.5">
          <Each of={statuses().filter((m) => m.state !== "online")} key={(m: MachineStatus) => m.id}>
            {(m) => <MachineGlyph status={m()} />}
          </Each>
        </View>
        <Rail />
        {settings()}
      </If>
      <If when={!rail()}>
        <If when={searchShown()}>
          <View class="pt-2">
            <SearchField
              value={query()}
              onChange={(v) => query.set(v)}
              placeholder="Search projects"
              inputRef={(ref) => {
                searchField = ref;
                if (!focusOnMount) return;
                focusOnMount = false;
                ref.focus();
              }}
            />
          </View>
        </If>
        <View class="min-h-0 flex-1">
          <Tree />
          <View
            class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-sidebar/0 to-sidebar"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </View>
        <If when={empty()}>
          <Text class="px-3 text-xs text-muted-foreground">
            {query().trim() ? "No project or agent matches" : board().statusLine}
          </Text>
        </If>
        <View class="gap-2">
          <SidebarFooter />
          {settings()}
        </View>
      </If>
    </View>
  );
}
