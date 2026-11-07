import { announce, computed, effect, keymap, List, signal, Text, View } from "nsh";
import type { JSX } from "nsh";
import { Button } from "nsh/base";
import { Herdr } from "herdr-desktop/native";
import type { BoardRow, MachineStatus } from "herdr-desktop/native";
import { machinesOpen, newAgentOpen, settingsOpen, sidebarSearch } from "../lib/actions";
import { focused, openPane, paneKey, showBoard, BOARD } from "../lib/dock";
import { board, revision } from "../lib/herdr";
import { linkGlyph, linkText } from "../lib/machine-state";
import { ofKind } from "../lib/list-item";
import { hoverTransition } from "../lib/motion";
import { isSelected, rangeTo, toggle } from "../lib/selection";
import { sidebarCollapsed } from "../lib/settings";
import { keyLabel } from "../lib/shortcuts";
import { ageText, folded, idleOpen, rowLabel, type SidebarItem, sidebarItems, toggleFold } from "../lib/sidebar";
import { Badge, Btn, Clipped, compact, FOCUS_RING_SIDEBAR, Icon, type IconName, IconButton, Kbd, rail, SearchField, Tipped } from "./kit";
import { PickBox } from "./pick-box";
import { StatusGlyph } from "./status-glyph";

/** Hover and the open pane are a quiet fill, nothing else. The focus ring is inset: see `FOCUS_RING_SIDEBAR`. */
const ROW = `rounded-md hover:bg-sidebar-accent/60 selected:bg-sidebar-accent ${FOCUS_RING_SIDEBAR}`;

const query = signal("");

const items = computed(() => sidebarItems(board(), query(), folded(), idleOpen()));
const rowKeys = computed(() => items().flatMap((i) => (i.kind === "row" ? [i.row.key] : [])));

/** The panel an agent's row opens: the row is lit while its tab is the one being worked in. */
const isOpen = (row: BoardRow) => focused() === paneKey(row.machine, row.paneId);

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

function MachineRow(props: { status: MachineStatus }) {
  const s = () => props.status;
  const line = () => linkText(s());
  const label = () => `${s().name}, ${line()}`;
  return (
    <If
      when={!rail()}
      else={
        <Tipped label={label()} class="items-center">
          <Button onPress={() => machinesOpen.set(true)} accessibilityLabel={label()} style={hoverTransition()} class={`h-7 w-10 items-center justify-center ${ROW}`}>
            <StatusGlyph status={linkGlyph(s().state)} />
          </Button>
        </Tipped>
      }
    >
      <View class="gap-0.5">
        <Button onPress={() => machinesOpen.set(true)} accessibilityLabel={label()} style={hoverTransition()} class={`min-h-9 flex-row items-center gap-2.5 px-2 py-1 ${ROW}`}>
          <StatusGlyph status={linkGlyph(s().state)} />
          <View class="min-w-0 flex-1">
            <Clipped class="text-sm text-sidebar-foreground">{s().name}</Clipped>
            <Clipped lines={2} class="text-xs text-muted-foreground">{line()}</Clipped>
          </View>
        </Button>
        <If when={s().state === "attention"}>
          <View class="items-start px-2 pb-1">
            <Btn small variant="outline" label="Fix" name={`Fix ${s().name}`} onPress={() => machinesOpen.set(true)} />
          </View>
        </If>
      </View>
    </If>
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

function AgentRow(props: { row: () => BoardRow }) {
  const row = props.row;
  const keys = useRowKeys(row);
  const sub = () => [row().agent, row().machineName, ageText(row().sinceSecs), row().offline ? "offline" : ""].filter(Boolean).join(" · ");
  const open = () => void openPane(row().machine, row().paneId);
  return (
    <If
      when={!rail()}
      else={
        <Tipped label={rowLabel(row())} class="items-center">
          <Button onPress={open} selected={isOpen(row())} accessibilityLabel={rowLabel(row())} style={hoverTransition()} class={`h-9 w-10 items-center justify-center ${ROW} ${row().offline ? "opacity-60" : ""}`}>
            <StatusGlyph status={row().status} />
          </Button>
        </Tipped>
      }
    >
      <View class="group flex-row items-center">
        <View class={`pl-1 ${isSelected(row().key) ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
          <PickBox rowKey={row().key} name={row().name} order={rowKeys} />
        </View>
        <View
          role="button"
          onPress={open}
          accessibilityState={{ selected: isOpen(row()) }}
          accessibilityLabel={rowLabel(row())}
          onFocus={keys.onFocus}
          onBlur={keys.onBlur}
          style={hoverTransition()}
          class={`min-h-10 min-w-0 flex-1 flex-row items-center gap-2.5 px-2 py-1 ${ROW} ${row().offline ? "opacity-60" : ""}`}
        >
          <StatusGlyph status={row().status} />
          <View class="min-w-0 flex-1">
            <Clipped class="text-sm text-sidebar-foreground">{row().name}</Clipped>
            <Clipped class="text-xs text-muted-foreground">{sub()}</Clipped>
          </View>
        </View>
      </View>
    </If>
  );
}

function Header(props: { item: () => Extract<SidebarItem, { kind: "header" }> }) {
  const it = props.item;
  const name = () => `${it().title}, ${it().count}`;
  return (
    <If
      when={!rail()}
      else={
        <View class="mx-2 my-1 h-px bg-sidebar-border" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      }
    >
      <If
        when={it().foldable}
        else={
          <View class="h-7 flex-row items-center justify-between px-2">
            <Text role="header" accessibilityLabel={name()} class="text-xs font-medium text-sidebar-foreground">
              {it().title}
            </Text>
            <Badge onSidebar tone="signal" count={it().count} />
          </View>
        }
      >
        <View
          role="button"
          onPress={() => toggleFold(it().section)}
          accessibilityLabel={name()}
          accessibilityState={{ expanded: !it().folded }}
          style={hoverTransition()}
          class={`h-7 flex-row items-center justify-between px-2 ${ROW}`}
        >
          <View class="flex-row items-center gap-1.5">
            <Icon name={it().folded ? "chevron-right" : "chevron-down"} size={12} tone="muted-foreground" />
            <Text role="header" class="text-xs font-medium text-muted-foreground">
              {it().title}
            </Text>
          </View>
          <Badge onSidebar count={it().count} />
        </View>
      </If>
    </If>
  );
}

function More(props: { item: () => Extract<SidebarItem, { kind: "more" }> }) {
  const it = props.item;
  const text = () => (it().open ? "Show fewer idle" : `${it().count} more idle`);
  return (
    <If when={!rail()}>
      <View role="button" onPress={() => idleOpen.update((o) => !o)} accessibilityLabel={text()} accessibilityState={{ expanded: it().open }} style={hoverTransition()} class={`h-7 justify-center px-2 ${ROW}`}>
        <Text class="text-xs text-muted-foreground">{text()}</Text>
      </View>
    </If>
  );
}

/** The agents, grouped as the board groups them. Rows are recycled, so each reads its item and holds nothing of its own. */
function AgentList() {
  return (
    <List each={items()} keyExtractor={(i: SidebarItem) => i.key} estimatedItemSize={44} class="min-h-0 flex-1" contentClass="gap-0.5" accessibilityLabel="Agents">
      {(item) => {
        const row = ofKind(item, "row");
        const header = ofKind(item, "header");
        const more = ofKind(item, "more");
        return (
          <If when={item().kind === "row"} else={<If when={item().kind === "header"} else={<More item={more} />}><Header item={header} /></If>}>
            <AgentRow row={() => row().row} />
          </If>
        );
      }}
    </List>
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
  // Made here, not at the top of the file: the engine is configured after this module loads, and a computed runs at once.
  const statuses = computed<MachineStatus[]>(() => {
    revision();
    return Herdr.machineStatuses();
  });
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
          <NavRow icon="plus" label="New agent session" shortcut={keyLabel("newAgent")} onPress={() => newAgentOpen.set(true)}>
            <Kbd keys={keyLabel("newAgent")} tone="sidebar" />
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
      <View class="gap-0.5">
        <Each of={statuses()} key={(m: MachineStatus) => m.id}>
          {(m) => <MachineRow status={m()} />}
        </Each>
      </View>
      <If when={!rail()}>
        <SearchField value={query()} onChange={(v) => query.set(v)} placeholder="Search agents" inputRef={(ref) => (sidebarSearch.focus = () => ref.focus())} />
      </If>
      <AgentList />
      <If when={!rail() && empty()}>
        <Text class="px-2 text-xs text-muted-foreground">{query().trim() ? "No agent matches" : board().statusLine}</Text>
      </If>
      <NavRow icon="sliders" label="Settings" shortcut={keyLabel("settings")} onPress={() => settingsOpen.set(true)} />
    </View>
  );
}
