import { Text, View } from "nsh";
import type { QueuedView } from "herdr-desktop/native";
import { fileName } from "../lib/session-compose";
import { oneLine, visibleText } from "../lib/session-text";
import { Btn, Icon, IconButton } from "./kit";

/** Rows shown before `N more queued`. */
const SHOWN = 3;

/**
 * What waits for the turn to end, above the box, oldest first: the text cut to two lines, how many files go with it, and
 * a cross that takes the message back into the box (nothing is thrown away: it lands in the box, where it can be edited
 * or sent again). A held message says why and `Send now` lets it go. The queue is the agent's own order, so there is no
 * reordering.
 */
export function SessionQueue(props: { queue: readonly QueuedView[]; onTakeBack: (queued: QueuedView) => void; onSendNow: () => void }) {
  const held = () => props.queue.find((q) => q.held)?.held ?? null;
  const shown = () => props.queue.slice(0, SHOWN);
  const rest = () => props.queue.length - SHOWN;
  return (
    <View role="list" accessibilityLabel="Queued messages" class="gap-1">
      <Each of={shown()} key={(q: QueuedView) => String(q.id)}>
        {(q) => (
          <View
            role="group"
            accessibilityLabel={`Queued: ${oneLine(visibleText(q().text), 200)}${q().files.length > 0 ? `, ${q().files.length} files` : ""}`}
            class="flex-row items-center gap-2 rounded-lg bg-muted py-1 pl-3 pr-1"
          >
            <Icon name="clock" size={12} tone="muted-foreground" />
            <Text class="min-w-0 flex-1 text-sm text-foreground" style={{ numberOfLines: 2, textOverflow: "ellipsis" }}>
              {visibleText(q().text) || q().files.map(fileName).join(", ")}
            </Text>
            <If when={q().files.length > 0 && q().text !== ""}>
              <Text class="shrink-0 text-xs text-muted-foreground">{q().files.length === 1 ? "1 file" : `${q().files.length} files`}</Text>
            </If>
            <IconButton icon="x" label={`Take back: ${oneLine(visibleText(q().text) || q().files.map(fileName).join(", "), 60)}`} onPress={() => props.onTakeBack(q())} />
          </View>
        )}
      </Each>
      <If when={rest() > 0}>
        <Text class="px-3 text-xs text-muted-foreground">{`${rest()} more queued`}</Text>
      </If>
      <If when={held()}>
        {(why) => (
          <View class="flex-row items-center gap-2 px-1">
            <Text role="alert" class="min-w-0 flex-1 text-xs text-muted-foreground">{`Held: ${why()}`}</Text>
            <Btn small label="Send now" name="Send queued messages now" onPress={props.onSendNow} />
          </View>
        )}
      </If>
    </View>
  );
}
