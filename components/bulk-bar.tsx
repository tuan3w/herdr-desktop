import { signal, Text, View } from "nsh";

import { BulkConfirm, pickedRows } from "#components/bulk-confirm";
import { Btn, IconButton } from "#kit";
import type { BulkAction } from "#lib/bulk";
import { allRows, board, reviewable, reviewWithUndo } from "#lib/herdr";
import { clear, select, selected } from "#lib/selection";

/**
 * What can be done to the agents picked in the board or the sidebar: `Reviewed` (at once, one `Undo`), `Stop` (Esc),
 * `Message` and `Close`, each through a confirm dialog built from live data. It exists only while something is
 * picked and is mounted once, under the page, so both lists share it.
 */
export function BulkBar() {
  const pending = signal<BulkAction | undefined>(undefined);
  const count = () => selected().length;
  return (
    <>
      <If when={count() > 0}>
        <View
          role="group"
          accessibilityLabel="Selected agents"
          class="flex-row flex-wrap items-center gap-2 border-t border-border bg-card px-4 py-2"
        >
          <Text class="mr-2 text-sm font-medium text-foreground">{`${count()} selected`}</Text>
          <Btn
            small
            label="Reviewed"
            disabled={reviewable(pickedRows()).length === 0}
            onPress={() => {
              reviewWithUndo(pickedRows());
              clear();
            }}
          />
          <Btn small label="Stop" onPress={() => pending.set("stop")} />
          <Btn small label="Message" onPress={() => pending.set("message")} />
          <Btn small label="Close" onPress={() => pending.set("close")} />
          <Btn small variant="ghost" label="Select all" onPress={() => select(allRows(board()).map((r) => r.key))} />
          <IconButton icon="x" label="Clear selection" onPress={clear} />
        </View>
      </If>
      <BulkConfirm action={pending()} onClose={() => pending.set(undefined)} />
    </>
  );
}
