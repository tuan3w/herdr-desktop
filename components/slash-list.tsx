import { effect, Scroll, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { ScrollRef } from "nsh/types";

import { FOCUS_RING_INSET, offsetsOf, revealOffset } from "#kit";
import { commandText, type SlashCommand, usageKey } from "#lib/slash";

/** One row's height in points: the list scrolls by whole rows to keep the highlighted one in view. */
const ROW = 32;
/** Rows visible at once. */
const VISIBLE = 7;

/**
 * The commands the composer's first word can complete to, as a list above it. The composer keeps the keyboard focus and
 * moves `highlighted`; a press on a row picks it too. `Pin` is the row's second action, so pinning has a button as well
 * as a gesture. Each row is named by its command and what it does.
 */
export function SlashList(props: {
  commands: SlashCommand[];
  highlighted: number;
  pinned: (key: string) => boolean;
  onPick: (command: SlashCommand) => void;
  onTogglePin: (command: SlashCommand) => void;
}) {
  let scroll: ScrollRef | undefined;
  // The offset the person (or the last reveal) left the list at, from `onScroll`.
  let offset = 0;
  // Move only when the highlighted row is out of view, and only as far as its edge.
  effect(() => {
    const rows = offsetsOf(props.commands.map(() => ROW));
    const y = revealOffset(rows, props.highlighted, offset, ROW * Math.min(VISIBLE, props.commands.length));
    if (y === undefined) return;
    offset = y;
    scroll?.scrollTo({ y, animated: false });
  });
  return (
    <View
      role="listbox"
      accessibilityLabel="Commands"
      class="overflow-hidden rounded-md border border-border bg-popover"
      style={{ maxHeight: ROW * VISIBLE }}
    >
      <Scroll
        ref={(node: ScrollRef) => {
          scroll = node;
        }}
        onScroll={(e) => {
          offset = e.offset.y;
        }}
      >
        <Each of={props.commands} key="index">
          {(command, i) => (
            <View
              style={{ height: ROW }}
              class={`flex-row items-center gap-2 pr-1 ${i() === props.highlighted ? "bg-accent" : ""}`}
            >
              <Button
                role="option"
                accessibilityLabel={`${commandText(command())}${command().description ? `, ${command().description}` : ""}`}
                selected={i() === props.highlighted}
                onPress={() => props.onPick(command())}
                class={`h-full min-w-0 flex-1 flex-row items-center gap-3 px-3 ${FOCUS_RING_INSET}`}
              >
                <Text class="text-sm font-medium text-popover-foreground">{commandText(command())}</Text>
                <Text
                  class="min-w-0 flex-1 text-xs text-muted-foreground"
                  style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
                >
                  {command().description}
                </Text>
              </Button>
              <Button
                accessibilityLabel={`${props.pinned(usageKey(command())) ? "Unpin" : "Pin"} ${commandText(command())}`}
                onPress={() => props.onTogglePin(command())}
                class={`h-6 items-center justify-center rounded px-2 hover:bg-accent ${FOCUS_RING_INSET}`}
              >
                <Text class="text-xs text-muted-foreground">
                  {props.pinned(usageKey(command())) ? "Pinned" : "Pin"}
                </Text>
              </Button>
            </View>
          )}
        </Each>
      </Scroll>
    </View>
  );
}
