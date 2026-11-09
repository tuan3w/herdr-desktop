import { Herdr } from "herdr-desktop/native";
import { computed, effect, List, signal, Text, untracked, View } from "nsh";

import type { BoardRow } from "herdr-desktop/native";

import { Chips, machineStatuses, TableHeader, TableLine } from "#components/board-card";
import { BulkAnswer } from "#components/bulk-answer";
import { Btn, Empty, FOCUS_RING, NUM } from "#kit";
import { chipCount, inFilter, tableItems } from "#lib/board-table";
import type { BoardFilter, TableItem } from "#lib/board-table";
import { hasAnswerView } from "#lib/bulk-answer";
import { headerOnBand, mainInset } from "#lib/chrome";
import { allRows, board, revision, reviewable } from "#lib/herdr";
import { BAR, COLUMN, ROW } from "#lib/layout";
import { hoverTransition } from "#lib/motion";
import { select, selected } from "#lib/selection";
import { foldedProjects, keepItems, moreOpen } from "#lib/sidebar";

/** What an empty chip says: the state is what the person asked about, so the answer is about that state. */
const NOTHING: Record<Exclude<BoardFilter, "all">, string> = {
  blocked: "Nothing needs you",
  working: "Nothing is working",
  done: "Nothing to review",
  idle: "Nothing is idle",
};

/**
 * `3 to review, select them` beside the chips while `To review` is the filter: picks exactly those agents (and opens the
 * projects that were folded over them) for the bulk bar's `Reviewed`. A filter alone never picks anything.
 */
function PickToReview() {
  const finished = () => reviewable(allRows(board()));
  const pick = () => {
    select(finished().map((r) => r.key));
    const where = new Set(finished().map((r) => r.project));
    foldedProjects.update((all) => all.filter((k) => !where.has(k)));
  };
  return (
    <If when={finished().length > 0}>
      <View
        role="button"
        accessibilityLabel={`${finished().length} to review, select them`}
        onPress={pick}
        style={hoverTransition()}
        class={`rounded-md px-2 py-1 hover:bg-accent ${FOCUS_RING}`}
      >
        <Text style={NUM} class="text-sm text-muted-foreground underline">
          {`Select ${finished().length}`}
        </Text>
      </View>
    </If>
  );
}

/**
 * The home: the projects as a table, the same projects in the same order as the sidebar (`projectLines`), with the state
 * chips above it. The chips are the counts and the filter; an agent is never listed under a second heading. The list is
 * virtualized like the sidebar's tree and keeps its lines by identity (`keepItems`), so a tick does not slide the
 * person's place. Opening an agent does not review it; `Reviewed` does, with one `Undo`. `onAddMachine` offers the
 * first-run pointer when only this computer is known.
 */
export function Board(props: {
  onOpen: (row: BoardRow, options?: { reply?: boolean }) => void;
  onAddMachine?: () => void;
}) {
  const filter = signal<BoardFilter>("all");
  let shown: TableItem[] = [];
  const items = computed(
    () => (shown = keepItems(shown, tableItems(board(), machineStatuses(), filter(), foldedProjects(), moreOpen()))),
  );
  const order = computed(() => items().flatMap((i) => (i.kind === "row" ? [i.row.key] : [])));
  const machines = computed(() => {
    revision();
    return Herdr.machines().filter((m) => m.enabled);
  });
  const lonely = () => machines().length <= 1 && board().projects.length === 0;

  // A row the chip hides leaves the selection: a bulk action never reaches an agent that is not in the table.
  effect(() => {
    const f = filter();
    const rows = allRows(board());
    const picked = untracked(selected);
    if (f === "all" || picked.length === 0) return;
    const visible = new Set(rows.filter((r) => inFilter(r, f)).map((r) => r.key));
    const kept = picked.filter((k) => visible.has(k));
    if (kept.length !== picked.length) select(kept);
  });

  return (
    <View class="min-h-0 flex-1 items-center">
      <If
        when={board().projects.length > 0}
        else={
          <Empty
            fill
            icon="monitor"
            title={lonely() ? "Add your first machine" : "No agents yet"}
            hint={
              lonely()
                ? "Agents running under herdr on this computer show up here. Add a machine to watch others too."
                : "Agents running under herdr appear here."
            }
          >
            <If when={lonely() && props.onAddMachine}>
              <Btn label="Add machine" onPress={() => props.onAddMachine?.()} />
            </If>
          </Empty>
        }
      >
        {/* The chips are the Board's first line, on the window's top band (`BAR`): it drags the window there and keeps clear of the window controls. */}
        <View class="min-h-0 w-full flex-1 gap-3 px-6" style={{ maxWidth: COLUMN.home }}>
          {/* A wrapping row packs its lines at the top: the outer view centres them in the band. */}
          <View
            desktop={{ windowDrag: headerOnBand() }}
            style={{ minHeight: BAR, paddingRight: headerOnBand() ? mainInset().right : 0 }}
            class="justify-center"
          >
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <Chips
                filter={filter}
                counts={(f) => chipCount(board().counts, f)}
                onFilter={(next) => filter.set(next)}
              />
              <If when={filter() === "done"}>
                <PickToReview />
              </If>
            </View>
          </View>
          <If when={filter() === "blocked" && hasAnswerView(allRows(board()))}>
            <BulkAnswer />
          </If>
          <TableHeader />
          <If
            when={items().length > 0}
            else={
              <Text class="px-3 text-sm text-muted-foreground">
                {filter() === "all" ? "Nothing to show" : NOTHING[filter() as Exclude<BoardFilter, "all">]}
              </Text>
            }
          >
            <List
              each={items()}
              keyExtractor={(i: TableItem) => i.key}
              estimatedItemSize={ROW.table.height}
              class="min-h-0 flex-1"
              contentClass="pb-8"
              accessibilityLabel="Projects"
            >
              {(item) => <TableLine item={item} order={order} onOpen={props.onOpen} />}
            </List>
          </If>
        </View>
      </If>
    </View>
  );
}
