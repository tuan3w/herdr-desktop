import { computed, Scroll, View } from "nsh";

import { machineStatuses, TableLine } from "#components/board-card";
import { Empty } from "#kit";
import type { TableItem } from "#lib/board-table";
import { tableItems } from "#lib/board-table";
import { context } from "#lib/dock";
import { board, projectOf } from "#lib/herdr";
import { COLUMN, PAD } from "#lib/layout";
import { openAgent } from "#lib/open-agent";
import { moreOpen } from "#lib/sidebar";

/**
 * What a project's workspace shows while it has no tab open (a project never opened, or one whose last tab was closed):
 * the project's own card from the board, with its agents, what they are doing and `New agent session`, so a context is
 * never blank and the way into it is one press. A press on an agent opens it in this project's tabs. Nothing here needs
 * the person: what waits is said by the card once, as everywhere (`design/attention.md`).
 */
export function ProjectEmpty() {
  const project = () => projectOf(context());
  // The board's own lines for this one project, never folded: it is the whole page.
  const items = computed(() =>
    tableItems(
      { ...board(), projects: board().projects.filter((p) => p.key === context()) },
      machineStatuses(),
      "all",
      [],
      moreOpen(),
    ),
  );
  const order = computed(() => items().flatMap((i) => (i.kind === "row" ? [i.row.key] : [])));
  return (
    <If
      when={project()}
      else={
        <Empty
          fill
          title="This project is gone"
          hint="Its agents are not on the board any more. Press Ctrl+1 for the board."
        />
      }
    >
      {(p) => (
        <Scroll class="min-h-0 flex-1" contentClass="items-center" accessibilityLabel={`${p().name}, no tabs open`}>
          <View class={`w-full pb-8 ${PAD.page}`} style={{ maxWidth: COLUMN.home }}>
            <Each of={items()} key={(i: TableItem) => i.key}>
              {(item) => <TableLine item={item} order={order} fold={false} onOpen={(row) => void openAgent(row)} />}
            </Each>
          </View>
        </Scroll>
      )}
    </If>
  );
}
