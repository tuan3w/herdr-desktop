import { cleanup, effect, keymap, List, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { Signal } from "nsh";
import type { ListRef } from "nsh/types";

import { EarlierRow } from "#components/earlier-row";
import type { RowContext } from "#components/session-item";
import { SessionRow } from "#components/session-item";
import { StatusGlyph } from "#components/status-glyph";
import { FOCUS_RING, Icon } from "#kit";
import { createAutoLoad, type Earlier } from "#lib/earlier";
import { CHAT_COLUMN } from "#lib/layout";
import { leaving, reducedMotion } from "#lib/motion";
import { tally } from "#lib/perf-counts";
import type { Row } from "#lib/session-rows";
import { visibleText } from "#lib/session-text";
import { DEFAULT_ROW_PT, estimateRowPt, FOLLOW_PT, isAtEnd, pageOffset } from "#lib/transcript-scroll";
import { anchorOf, setAnchor } from "#lib/view-state";

/** How long a chat waits for enough of its conversation to put the person back where they were. */
const PLACE_MS = 1500;

/** How long a page key's target outlives its press: past nsh's eased scroll (300 ms on macOS), so a held key pages on from it. */
const PAGE_AIM_MS = 400;

/** What the transcript lets the tab do: jump to the newest row; and where it is scrolled (a lab reads it). */
export interface TranscriptHandle {
  jump(): void;
  where(): { offset: number; content: number; size: number };
}

/** What closes the list: that the session ended and why, or the one live line (what the agent does now, and how quiet). */
function Footer(props: { ctx: RowContext }) {
  const working = () => props.ctx.model.working();
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
      <If when={working()}>
        {(w) => (
          <View role="timer" accessibilityLabel={w().toolLine} class="flex-row items-center gap-2">
            {/* The same half ring a running call wears, so the line reads as the next row of the run above it. */}
            <StatusGlyph status="working" size={12} />
            <Text class="text-sm text-muted-foreground">{w().toolLine}</Text>
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
 *
 * Where the person left a chat comes back with it (switching project unmounts the tab): at the end it opens at the end,
 * scrolled away it opens that far above the end once the conversation is long enough to place it, and gives up on that
 * after `PLACE_MS` and shows the end.
 */
export function SessionTranscript(props: {
  ctx: RowContext;
  /** The tab's panel key: where the chat was left is kept under it (`lib/view-state.ts`). */
  panel: string;
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
  const estimate = signal(DEFAULT_ROW_PT);
  /** Where the last page key sent the list, while its eased move may still be on the way (`page`). */
  let aim: { offset: number; at: number } | undefined;
  let lastUser = "";
  const left = anchorOf(props.panel);
  let pending = left && !left.atEnd ? left : undefined;

  const jump = () => {
    aim = undefined;
    list?.scrollToEnd({ animated: false });
    metrics.offset = Math.max(0, metrics.content - metrics.size);
    props.atEnd.set(true);
    props.unseen.set(0);
  };
  props.onHandle?.({ jump, where: () => ({ ...metrics }) });

  const rows = () => props.ctx.model.rows();

  // Opening shows the end (or where the person left it); the list keeps it there as rows are measured.
  effect(() => {
    if (rows().length === 0 || placed()) return;
    untracked(() => {
      // Once, from the rows it opens with: a change later would move every row not yet measured, under the reader.
      estimate.set(estimateRowPt(rows()));
      placed.set(true);
      if (!pending) {
        setTimeout(jump, 0);
        return;
      }
      // A list reports its size once it scrolls: go to the end first, which also makes the report, then back up.
      setTimeout(() => list?.scrollToEnd({ animated: false }), 0);
      setTimeout(() => {
        if (!pending) return;
        pending = undefined;
        jump();
      }, PLACE_MS);
    });
  });
  // What the person just sent is where they look next.
  effect(() => {
    const last = [...rows()].reverse().find((r) => r.kind === "user");
    const key = last?.key ?? "";
    if (key !== lastUser && lastUser !== "") untracked(jump);
    lastUser = key;
  });

  // The offset is also written here: `onScroll` is throttled, and a held key repeats faster, so the next press would
  // read the offset from before this one and lose a page.
  const moveTo = (offset: number) => {
    aim = undefined;
    metrics.offset = offset;
    list?.scrollToOffset({ offset, animated: false });
  };
  // A page glides (nsh's eased scroll, on the platform's side) unless motion is reduced. While it glides the list reports
  // the offsets it passes, so a press soon after pages on from where the last one aimed, not from where the glide is.
  const page = (direction: 1 | -1) => {
    const now = performance.now();
    const from = aim && now - aim.at < PAGE_AIM_MS ? aim.offset : metrics.offset;
    const offset = pageOffset(from, metrics.size, metrics.content, direction);
    const glide = !reducedMotion();
    aim = glide ? { offset, at: now } : undefined;
    metrics.offset = offset;
    list?.scrollToOffset({ offset, animated: glide });
  };
  effect(() => {
    if (!props.active) return;
    const always = keymap.bind({ pageup: () => page(-1), pagedown: () => page(1) }, { when: "always" });
    const idle = keymap.bind(
      {
        home: () => moveTo(0),
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
  const shownPill = leaving(pill);

  // Older turns of a terminal agent's log: a row above the first says so, and coming within a screen of the top reads them
  // (once per arrival); the older rows land above the ones in view, which keep their place.
  const earlier = (): Earlier => (props.ctx.model.view()?.observed?.earlier as Earlier | undefined) ?? "none";
  const autoLoad = createAutoLoad();
  effect(() => {
    if (rows().length === 0 && autoLoad(0, 1, earlier())) props.ctx.model.loadEarlier();
  });

  return (
    <View class="min-h-0 flex-1">
      <List
        ref={(node: ListRef) => {
          list = node;
        }}
        each={rows() as Row[]}
        keyExtractor={(r: Row) => r.key}
        estimatedItemSize={estimate()}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: FOLLOW_PT }}
        scrollEventThrottle={50}
        onScroll={(e) => {
          tally("scroll.event");
          metrics.offset = e.offset.y;
          metrics.content = e.contentSize.height;
          metrics.size = e.size.height;
          if (pending) {
            // Still opening: scroll events before the place is reached say nothing about where the person is.
            if (e.contentSize.height - e.size.height < pending.fromEnd) return;
            const to = Math.max(0, e.contentSize.height - e.size.height - pending.fromEnd);
            pending = undefined;
            props.atEnd.set(false);
            list?.scrollToOffset({ offset: to, animated: false });
            return;
          }
          if (autoLoad(e.offset.y, e.size.height, earlier())) props.ctx.model.loadEarlier();
          const end = isAtEnd(e.offset.y, e.size.height, e.contentSize.height);
          setAnchor(props.panel, {
            atEnd: end,
            fromEnd: Math.max(0, e.contentSize.height - (e.offset.y + e.size.height)),
          });
          if (end !== props.atEnd()) props.atEnd.set(end);
          if (end && props.unseen() > 0) props.unseen.set(0);
        }}
        role="list"
        accessibilityLabel="Conversation"
        class="min-h-0 flex-1"
        contentClass="gap-2 pb-6 pt-4"
        header={() => <EarlierRow earlier={earlier()} onLoad={() => props.ctx.model.loadEarlier()} />}
        footer={() => <Footer ctx={props.ctx} />}
        empty={() => (
          <View class={`py-8 ${CHAT_COLUMN}`}>
            <Text class="text-sm text-muted-foreground">
              {props.opening() ? "Opening the session…" : "Nothing here yet."}
            </Text>
          </View>
        )}
      >
        {(row, index) => <SessionRow row={row} index={index} ctx={props.ctx} />}
      </List>
      <If when={shownPill.value()}>
        {(label) => (
          <View style={shownPill.style} class="absolute bottom-3 left-0 right-0 items-center">
            <Button
              onPress={jump}
              accessibilityLabel={label()}
              class={`h-9 flex-row items-center gap-2 rounded-full border border-border bg-popover px-3 ${FOCUS_RING}`}
            >
              <Icon name="chevron-down" size={14} tone={props.waiting() ? "signal" : "muted-foreground"} />
              <Text class={`text-sm font-medium ${props.waiting() ? "text-signal" : "text-popover-foreground"}`}>
                {label()}
              </Text>
            </Button>
          </View>
        )}
      </If>
    </View>
  );
}
