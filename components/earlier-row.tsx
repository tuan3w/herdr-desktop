import { Text, View } from "nsh";

import { Btn, Spinner } from "#kit";
import { type Earlier, TOO_LONG } from "#lib/earlier";

/**
 * The top of an observed chat's list (`design/chat.md`, "Earlier messages"): what stands between the rows and the
 * start of the log. Available: one quiet ghost button. Loading: a line of the same height (28), so nothing jumps when
 * the read starts or lands. Too long: one muted sentence, no button, because there is nothing to press. None: nothing.
 * It is a row of the list, not a bar over it, so it scrolls away with the rows.
 */
export function EarlierRow(props: { earlier: Earlier; onLoad: () => void }) {
  return (
    <>
      <If when={props.earlier === "available"}>
        <View class="min-h-7 items-center justify-center">
          <Btn label="Load earlier messages" variant="ghost" small onPress={props.onLoad} />
        </View>
      </If>
      <If when={props.earlier === "loading"}>
        <View
          accessibilityLabel="Loading earlier messages"
          accessibilityState={{ busy: true }}
          class="min-h-7 flex-row items-center justify-center gap-2"
        >
          <Spinner size={14} tone="muted-foreground" />
          <Text class="text-xs text-muted-foreground">Loading earlier messages…</Text>
        </View>
      </If>
      <If when={props.earlier === "tooLong"}>
        <View class="min-h-7 items-center justify-center px-3">
          <Text class="text-center text-xs text-muted-foreground">{TOO_LONG}</Text>
        </View>
      </If>
    </>
  );
}
