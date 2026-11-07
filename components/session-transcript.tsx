import { cleanup, effect, keymap, List, signal, Text, untracked, View } from "nsh";
import type { Signal } from "nsh";
import type { ListRef } from "nsh/types";
import { Button } from "nsh/base";
import type { Row } from "../lib/session-rows";
import { durationText, visibleText } from "../lib/session-text";
import { CHAT_COLUMN } from "#lib/layout";
import { appear } from "../lib/motion";
import { FOCUS_RING, Icon } from "./kit";
import { RowContext, SessionRow } from "./session-item";

/** How far from the end still counts as being at it: a streamed line or two must not unstick the view. */
const AT_END = 64;

/** What the transcript lets the tab do: jump to the newest row. */
export interface TranscriptHandle {
  jump(): void;
}

/** What closes the list: that the session ended and why, or that the agent is working (and for how long, and how quiet). */
function Footer(props: { ctx: RowContext }) {
  const working = () => props.ctx.model.working();
  const text = () => {
    const w = working();
    if (!w) return "";
    return w.seconds === null ? "Working" : `Working · ${durationText(w.seconds)}`;
  };
  // A group that is open and running already says `Working`, line by line: the footer then only speaks when it is quiet.
  const redundant = () => props.ctx.model.rows().at(-1)?.kind === "tool" && working()?.quietMinutes === null;
  const ended = (): string | null => {
    const v = props.ctx.model.view();
    if (v?.phase !== "ended") return null;
    return v.endedReason ? `Session ended: ${visibleText(v.endedReason)}` : "Session ended";
  };
  return (
    <View class={`min-h-9 py-2 ${CHAT_COLUMN}`}>
      <If when={ended()}>
        {(text) => (
          <View role="group" accessibilityLabel={text()} class="items-center py-1">
            <Text class="text-xs text-muted-foreground">{text()}</Text>
          </View>
        )}
      </If>
      <If when={redundant() ? null : working()}>
        {(w) => (
          <View role="timer" accessibilityLabel={text()} class="flex-row items-center gap-2 px-2">
            <Text class="text-sm text-muted-foreground">{text()}</Text>
            <If when={w().quietMinutes !== null}>
              <Text class="text-sm font-medium text-foreground">{`Quiet for ${w().quietMinutes}m`}</Text>
            </If>
          </View>
        )}
      </If>
    </View>
  );
}

/**
 * The conversation as one virtual list, bottom aligned like a chat: only the rows near the window exist, each reads its
 * row and keeps no state of its own. It follows the end while the person is at the end; scrolled away it holds still and
 * a pill says what is new (`3 new messages`, or `Needs you` while a request waits) and jumps back. Sending a message
 * jumps too. PageUp and PageDown scroll a page from anywhere in the tab, Home and End when no text box has the focus.
 *
 * `atEnd` and `unseen` are the tab's, because the model's hook counts messages that arrive while the person is away.
 */
export function SessionTranscript(props: {
  ctx: RowContext;
  active: boolean;
  atEnd: Signal<boolean>;
  unseen: Signal<number>;
  waiting: () => boolean;
  opening: () => boolean;
  onHandle?: (handle: TranscriptHandle) => void;
}) {
  let list: ListRef | undefined;
  const metrics = { offset: 0, content: 0, size: 0 };
  const placed = signal(false);
  let lastUser = "";

  const jump = () => {
    list?.scrollToEnd({ animated: false });
    props.atEnd.set(true);
    props.unseen.set(0);
  };
  props.onHandle?.({ jump });

  const rows = () => props.ctx.model.rows();

  // Opening shows the end; the list keeps it there as rows are measured.
  effect(() => {
    if (rows().length === 0 || placed()) return;
    untracked(() => {
      placed.set(true);
      setTimeout(jump, 0);
    });
  });
  // What the person just sent is where they look next.
  effect(() => {
    const last = [...rows()].reverse().find((r) => r.kind === "user");
    const key = last?.key ?? "";
    if (key !== lastUser && lastUser !== "") untracked(jump);
    lastUser = key;
  });

  const page = (direction: 1 | -1) => {
    const to = Math.max(0, Math.min(metrics.content - metrics.size, metrics.offset + direction * metrics.size * 0.9));
    list?.scrollToOffset({ offset: to, animated: false });
  };
  effect(() => {
    if (!props.active) return;
    const always = keymap.bind({ pageup: () => page(-1), pagedown: () => page(1) }, { when: "always" });
    const idle = keymap.bind(
      {
        home: () => list?.scrollToOffset({ offset: 0, animated: false }),
        end: jump,
      },
      { when: "notEditing" },
    );
    return () => {
      always();
      idle();
    };
  });
  cleanup(() => props.unseen.set(0));

  const pill = (): string | null => {
    if (props.atEnd()) return null;
    if (props.waiting()) return "Needs you";
    const n = props.unseen();
    return n > 0 ? `${n} new ${n === 1 ? "message" : "messages"}` : "Jump to latest";
  };

  return (
    <View class="min-h-0 flex-1">
      <List
        ref={(node: ListRef) => {
          list = node;
        }}
        each={rows() as Row[]}
        keyExtractor={(r: Row) => r.key}
        estimatedItemSize={72}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: AT_END }}
        scrollEventThrottle={50}
        onScroll={(e) => {
          metrics.offset = e.offset.y;
          metrics.content = e.contentSize.height;
          metrics.size = e.size.height;
          const end = e.offset.y + e.size.height >= e.contentSize.height - AT_END;
          if (end !== props.atEnd()) props.atEnd.set(end);
          if (end && props.unseen() > 0) props.unseen.set(0);
        }}
        role="list"
        accessibilityLabel="Conversation"
        class="min-h-0 flex-1"
        contentClass="gap-2 pb-6 pt-4"
        footer={() => <Footer ctx={props.ctx} />}
        empty={() => (
          <View class={`py-8 ${CHAT_COLUMN}`}>
            <Text class="text-sm text-muted-foreground">{props.opening() ? "Opening the session…" : "Nothing here yet. Ask anything below."}</Text>
          </View>
        )}
      >
        {(row) => <SessionRow row={row} ctx={props.ctx} />}
      </List>
      <If when={pill()}>
        {(label) => (
          <View style={appear()} class="absolute bottom-3 left-0 right-0 items-center">
            <Button
              onPress={jump}
              accessibilityLabel={label()}
              class={`h-9 flex-row items-center gap-2 rounded-full border border-border bg-popover px-3 ${FOCUS_RING}`}
            >
              <Icon name="chevron-down" size={14} tone={props.waiting() ? "signal" : "muted-foreground"} />
              <Text class={`text-sm font-medium ${props.waiting() ? "text-signal" : "text-popover-foreground"}`}>{label()}</Text>
            </Button>
          </View>
        )}
      </If>
    </View>
  );
}
