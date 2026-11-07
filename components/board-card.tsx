import { Herdr } from "herdr-desktop/native";
import { computed, Text, View } from "nsh";

import type { BoardRow, MachineStatus } from "herdr-desktop/native";

import { PickSlot, useRowKeys } from "#components/pick-box";
import { ProjectMark } from "#components/project-parts";
import { StatusGlyph } from "#components/status-glyph";
import { Badge, Btn, Clipped, FOCUS_RING, FOCUS_RING_INSET, Icon, NUM } from "#kit";
import { newSession } from "#lib/actions";
import type { BoardFilter, TableItem } from "#lib/board-table";
import { CHIPS } from "#lib/board-table";
import { projectOf, revision, reviewWithUndo, started } from "#lib/herdr";
import { ROW } from "#lib/layout";
import { ofKind } from "#lib/list-item";
import { hoverTransition } from "#lib/motion";
import { openProject } from "#lib/nav";
import { ageText, projectFolder, projectLabel, rowLabel, toggleMore, toggleProject } from "#lib/sidebar";

/**
 * The columns of the table, one place for the header and every row so they line up: the glyph, the title (two fifths),
 * `Last` (the rest) and the age. Widths are the one thing that must agree between a row and the header above it.
 */
const COL = { glyph: "w-3", title: "w-2/5 min-w-0", last: "min-w-0 flex-1", age: "w-16" } as const;

/** Every machine's link, for the amber of a project header; empty until the engine runs (this is built before `Herdr.configure`). */
export const machineStatuses = computed<MachineStatus[]>(() => {
  if (!started()) return [];
  revision();
  return Herdr.machineStatuses();
});

type Item<K extends TableItem["kind"]> = Extract<TableItem, { kind: K }>;

/** The state filters as buttons, each carrying its count (`Need you, 2`): the one place the Board says how many. */
export function Chips(props: {
  filter: () => BoardFilter;
  counts: (filter: Exclude<BoardFilter, "all">) => number;
  onFilter: (next: BoardFilter) => void;
}) {
  return (
    <View role="group" accessibilityLabel="Filter by state" class="flex-row flex-wrap items-center gap-2">
      <Each of={CHIPS} key="index">
        {(chip) => {
          const on = () => props.filter() === chip().filter;
          return (
            <View
              role="button"
              accessibilityLabel={`${chip().label}, ${props.counts(chip().filter)}`}
              accessibilityState={{ selected: on() }}
              onPress={() => props.onFilter(on() ? "all" : chip().filter)}
              style={hoverTransition()}
              class={`min-h-8 flex-row items-center gap-2 rounded-md border px-3 hover:bg-accent ${FOCUS_RING} ${on() ? "border-input bg-accent" : "border-border"}`}
            >
              <Text class="text-sm text-foreground">{chip().label}</Text>
              <Badge count={props.counts(chip().filter)} tone={chip().filter === "blocked" ? "signal" : "neutral"} />
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** The column titles. Static: the order is the board's, stable, never re-sorted by a click. */
export function TableHeader() {
  return (
    <View class={`flex-row items-center gap-3 border-b border-border ${ROW.project.class}`}>
      <View class={COL.glyph} />
      <Text class={`${COL.title} text-xs text-muted-foreground`}>Agent</Text>
      <Text class={`${COL.last} text-xs text-muted-foreground`}>Last</Text>
      <Text class={`${COL.age} text-right text-xs text-muted-foreground`}>Age</Text>
    </View>
  );
}

/**
 * A project: fold button, name, its machine (muted, amber when stale, none for this computer) and, while folded, how many
 * agents it holds with the signal dot when one waits. On hover or focus a pin and a new session in its folder. The same
 * header as the sidebar's, wider; it reads its item and holds no state, because the list recycles cells.
 */
export function ProjectHeader(props: { item: () => Item<"project">; fold?: boolean }) {
  const p = () => props.item().project;
  return (
    <View class={`group mt-3 ${p().offline ? "opacity-60" : ""}`}>
      <View class="flex-row items-center">
        <If when={props.fold !== false}>
          <View
            role="button"
            onPress={() => toggleProject(p().key)}
            accessibilityLabel={`${props.item().folded ? "Unfold" : "Fold"} ${p().name}`}
            accessibilityState={{ expanded: !props.item().folded }}
            style={hoverTransition()}
            class={`size-8 items-center justify-center rounded-md hover:bg-accent ${FOCUS_RING}`}
          >
            <Icon name={props.item().folded ? "chevron-right" : "chevron-down"} size={14} tone="muted-foreground" />
          </View>
        </If>
        <View
          role="button"
          onPress={() => openProject(p().key)}
          accessibilityLabel={projectLabel(p())}
          style={hoverTransition()}
          class={`min-w-0 flex-row items-center gap-2 rounded-md hover:bg-accent ${ROW.project.class} ${FOCUS_RING}`}
        >
          <Clipped class="min-w-0 shrink text-sm font-medium text-foreground">{p().name}</Clipped>
          <If when={p().pinned}>
            <Text class="text-xs text-muted-foreground">Pinned</Text>
          </If>
          <If when={props.item().machine !== null}>
            <Clipped class={`shrink text-xs ${props.item().stale ? "text-warning" : "text-muted-foreground"}`}>
              {props.item().machine ?? ""}
            </Clipped>
          </If>
          <If when={props.item().folded}>
            <Text style={NUM} class="text-xs text-muted-foreground">
              {`${props.item().count} ${props.item().count === 1 ? "agent" : "agents"}`}
            </Text>
            <ProjectMark project={p()} compact decorative />
          </If>
        </View>
        <View class="flex-1" />
      </View>
      <View class="absolute bottom-0 right-0 top-0 flex-row items-center gap-1 bg-background pl-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <Btn
          small
          variant="ghost"
          label={p().pinned ? "Unpin" : "Pin"}
          name={`${p().pinned ? "Unpin" : "Pin"} ${p().name}`}
          onPress={() => Herdr.pinProject(p().key, !p().pinned)}
        />
        <Btn
          small
          variant="ghost"
          icon="plus"
          label="New agent session"
          name={`New agent session in ${p().name}`}
          disabled={p().offline}
          onPress={() => newSession({ machine: p().machine, folder: projectFolder(p()) })}
        />
      </View>
    </View>
  );
}

/**
 * An agent in one line: its state as a quiet shape, its name, what it last said (or, while it waits, what it asks) and
 * how long it has been in this state. A machine that is not online dashes the shape and dims the line. A press opens the
 * agent; `Reviewed` (a finished one, on hover or focus) marks it; the box that picks it for a bulk action covers the glyph on
 * hover.
 */
export function AgentLine(props: {
  item: () => Item<"row">;
  order: () => readonly string[];
  onOpen: (row: BoardRow) => void;
}) {
  const row = () => props.item().row;
  const keys = useRowKeys(row, props.order);
  const dim = () => row().offline || props.item().stale;
  return (
    <View class={`group/row relative ${row().offline ? "opacity-60" : ""}`}>
      <View
        role="button"
        onPress={() => props.onOpen(row())}
        accessibilityLabel={rowLabel(row(), projectOf(props.item().project)?.name ?? "")}
        onFocus={keys.onFocus}
        onBlur={keys.onBlur}
        style={hoverTransition()}
        class={`flex-row items-center gap-3 rounded-md hover:bg-accent ${ROW.table.class} ${FOCUS_RING_INSET}`}
      >
        <View class={COL.glyph}>
          <StatusGlyph status={dim() ? "unknown" : row().status} id={row().key} />
        </View>
        <Clipped class={`${COL.title} text-sm text-foreground`}>{row().name}</Clipped>
        <Clipped class={`${COL.last} text-sm text-muted-foreground`}>{props.item().last}</Clipped>
        <Text style={NUM} class={`${COL.age} text-right text-xs text-muted-foreground`}>
          {ageText(row().sinceSecs)}
        </Text>
      </View>
      <If when={row().status === "done" && !row().offline}>
        <View class="absolute inset-y-0 right-20 justify-center bg-background opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <Btn
            small
            variant="ghost"
            label="Reviewed"
            name={`Reviewed: ${row().name}`}
            onPress={() => reviewWithUndo([row()])}
          />
        </View>
      </If>
      <PickSlot rowKey={row().key} name={row().name} order={props.order} surface="page" />
    </View>
  );
}

/** `3 more idle` under a project: the idle fold, opened and closed in place. */
export function MoreLine(props: { item: () => Item<"more"> }) {
  const it = props.item;
  const text = () => (it().open ? "Show fewer idle" : `${it().count} more idle`);
  return (
    <View
      role="button"
      onPress={() => toggleMore(it().project)}
      accessibilityLabel={`${text()} in ${projectOf(it().project)?.name ?? ""}`}
      accessibilityState={{ expanded: it().open }}
      style={hoverTransition()}
      class={`justify-center rounded-md pl-9 pr-3 hover:bg-accent ${ROW.more.class} ${FOCUS_RING_INSET}`}
    >
      <Text class="text-xs text-muted-foreground">{text()}</Text>
    </View>
  );
}

/**
 * One line of the table, whatever its kind: the one switch the board's list and a project's own page (`ProjectEmpty`, with
 * `fold` false: its only project is not foldable) both draw, so a line looks the same wherever it is.
 */
export function TableLine(props: {
  item: () => TableItem;
  order: () => readonly string[];
  onOpen: (row: BoardRow) => void;
  fold?: boolean;
}) {
  const project = ofKind(props.item, "project");
  const row = ofKind(props.item, "row");
  const more = ofKind(props.item, "more");
  return (
    <If
      when={props.item().kind === "project"}
      else={
        <If when={props.item().kind === "row"} else={<MoreLine item={more} />}>
          <AgentLine item={row} order={props.order} onOpen={props.onOpen} />
        </If>
      }
    >
      <ProjectHeader item={project} fold={props.fold} />
    </If>
  );
}
