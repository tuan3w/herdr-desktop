import { computed, List, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Herdr } from "herdr-desktop/native";
import type { BoardRow } from "herdr-desktop/native";
import { board, revision, reviewable } from "../lib/herdr";
import { hoverTransition } from "../lib/motion";
import { select } from "../lib/selection";
import { type BoardItem, boardItems } from "../lib/board-items";
import { ofKind } from "../lib/list-item";
import { folded, idleOpen, toggleFold } from "../lib/sidebar";
import { AgentCard, AgentRow } from "./board-card";
import { Btn, Empty, FOCUS_RING, Icon, NUM } from "./kit";
import { Triage } from "./triage";

/** A section's name; a foldable one is a button that folds it and says whether it is open. */
function Header(props: { item: BoardItem & { kind: "header" }; onTriage: () => void; triageable: boolean }) {
  const item = () => props.item;
  return (
    <View class="mt-3 flex-row items-center justify-between gap-2 px-1">
      <If
        when={item().foldable}
        else={
          <Text role="header" class="text-sm font-medium text-foreground">
            {item().title}
          </Text>
        }
      >
        <View
          role="button"
          accessibilityLabel={item().title}
          accessibilityState={{ expanded: !item().folded }}
          onPress={() => toggleFold(item().section)}
          style={hoverTransition()}
          class={`flex-row items-center gap-1 rounded-md py-1 pr-2 hover:bg-accent ${FOCUS_RING}`}
        >
          <Icon name={item().folded ? "chevron-right" : "chevron-down"} size={14} tone="muted-foreground" />
          <Text role="header" class="text-sm font-medium text-foreground">
            {item().title}
          </Text>
        </View>
      </If>
      <View class="flex-row items-center gap-3">
        <If when={item().note}>
          <Text style={NUM} class="text-xs text-muted-foreground">
            {item().note}
          </Text>
        </If>
        <If when={item().section === "needsYou" && props.triageable}>
          <Btn small label="Answer one by one" onPress={props.onTriage} />
        </If>
      </View>
    </View>
  );
}

/**
 * The status line, one count for every surface: only the needs-you words are loud, and `3 to review` is a button that
 * picks exactly those agents (and opens `To review` when it was folded) for the bulk bar's `Reviewed`.
 */
function StatusLine() {
  const parts = computed(() => board().statusLine.split(" · "));
  const pickToReview = () => {
    select(reviewable(board().toReview).map((r) => r.key));
    folded.update((all) => all.filter((s) => s !== "toReview"));
  };
  return (
    <View class="flex-row flex-wrap items-center gap-x-1.5 px-1">
      <Each of={parts()} key="index">
        {(part, i) => (
          <View class="flex-row items-center gap-1.5">
            <If when={i() > 0}>
              <Text class="text-sm text-muted-foreground">·</Text>
            </If>
            <If
              when={/^\d+ to review/.test(part())}
              else={
                <Text style={NUM} class={`text-sm ${/^\d+ need(s)? you/.test(part()) ? "font-medium text-signal" : "text-muted-foreground"}`}>
                  {part()}
                </Text>
              }
            >
              <View
                role="button"
                accessibilityLabel={`${part()}, select them`}
                onPress={pickToReview}
                style={hoverTransition()}
                class={`rounded-md px-1 hover:bg-accent ${FOCUS_RING}`}
              >
                <Text style={NUM} class="text-sm text-muted-foreground underline">
                  {part()}
                </Text>
              </View>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

/**
 * The board, the app's home: what needs you at the top, then what finished, what runs, what rests. Opening an agent
 * does not review it; `Reviewed` does, with one `Undo`. `onAddMachine` offers the first-run pointer when only this
 * computer is known.
 */
export function Board(props: { onOpenPane: (machine: string, pane: string, options?: { reply?: boolean }) => void; onAddMachine?: () => void }) {
  const triage = signal(false);
  const items = computed(() => boardItems(board(), folded(), idleOpen()));
  const order = computed(() => items().flatMap((i) => (i.kind === "card" || i.kind === "row" ? [i.row.key] : [])));
  const machines = computed(() => {
    revision();
    return Herdr.machines().filter((m) => m.enabled);
  });
  const several = () => machines().length > 1;
  const open = (row: BoardRow, options?: { reply?: boolean }) => props.onOpenPane(row.machine, row.paneId, options);
  const lonely = () => machines().length <= 1 && items().length === 0;

  return (
    <View class="min-h-0 flex-1 gap-2 px-4 pt-4">
      <StatusLine />
      <If
        when={items().length > 0}
        else={
          <Empty fill icon="monitor" title={lonely() ? "Add your first machine" : "No agents yet"} hint={lonely() ? "Agents running under herdr on this computer show up here. Add a machine to watch others too." : "Agents running under herdr appear here."}>
            <If when={lonely() && props.onAddMachine}>
              <Btn label="Add machine" onPress={() => props.onAddMachine?.()} />
            </If>
          </Empty>
        }
      >
        <List each={items()} keyExtractor={(i: BoardItem) => i.key} estimatedItemSize={72} class="min-h-0 flex-1" contentClass="gap-1 pb-6" accessibilityLabel="Agents">
          {(item) => {
            const header = ofKind(item, "header");
            const more = ofKind(item, "more");
            const card = ofKind(item, "card");
            const line = ofKind(item, "row");
            return (
              <If
                when={item().kind === "header"}
                else={
                  <If
                    when={item().kind === "more"}
                    else={
                      <If when={item().kind === "card"} else={<AgentRow row={line().row} several={several()} order={order} onOpen={open} />}>
                        <AgentCard row={card().row} several={several()} order={order} onOpen={open} />
                      </If>
                    }
                  >
                    <View class="px-1 py-1">
                      <Button
                        onPress={() => idleOpen.set(!idleOpen())}
                        accessibilityLabel={more().text}
                        style={hoverTransition()}
                        class={`self-start rounded-md px-2 py-1.5 hover:bg-accent ${FOCUS_RING}`}
                      >
                        <Text class="text-sm text-muted-foreground">{more().text}</Text>
                      </Button>
                    </View>
                  </If>
                }
              >
                <Header item={header()} onTriage={() => triage.set(true)} triageable={board().counts.needsYou > 1} />
              </If>
            );
          }}
        </List>
      </If>
      <Triage open={triage()} onClose={() => triage.set(false)} onOpenPane={(machine, pane) => props.onOpenPane(machine, pane)} />
    </View>
  );
}
