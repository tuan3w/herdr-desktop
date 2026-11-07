import { Sessions } from "herdr-desktop/native";
import { computed, Text, View } from "nsh";

import { NUM, Progress } from "#kit";
import { focused, parseSessionKey } from "#lib/dock";
import { revision } from "#lib/herdr";

/**
 * The context meter of the chat in front, one muted line under the workspace, right-aligned. It is drawn only while that
 * chat reports a context: on the Board, in a pane, or with an agent that reports none, nothing is drawn, not an empty bar.
 * It is the stand-in for the inspector's Overview tab, which does not exist yet (`design/context.md`). Counts and machine
 * links are not here: the Board badge and project marks say the first, the sidebar footer the second. Nothing is an
 * estimate. Not a live region.
 */
export function StatusBar() {
  const context = computed(() => {
    revision();
    const at = parseSessionKey(focused());
    return at ? (Sessions.view(at.machine, at.id)?.contextPercent ?? null) : null;
  });
  return (
    <If when={context() !== null}>
      <View
        role="group"
        accessibilityLabel="Status"
        class="h-8 flex-row items-center justify-end gap-2 border-t border-border bg-sidebar px-4"
      >
        <Text style={NUM} class="text-xs text-muted-foreground">{`Context ${context()}%`}</Text>
        <Progress label="Context used" value={context()} class="w-20" />
      </View>
    </If>
  );
}
