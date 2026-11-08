import { cleanup, effect, Image, type JSX, Overlay, Scroll, signal, Text, token, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { MentionView, PeekView } from "herdr-desktop/native";
import type { Bounds, ScrollRef, ViewRef } from "nsh/types";

import { FileName } from "#components/file-row";
import { Clipped, EDGE, FOCUS_RING_INSET, Keys, offsetsOf, revealOffset, Tipped } from "#kit";
import {
  BUBBLE_GAP,
  bubbleBox,
  createSettle,
  PEEK_HEAD,
  PEEK_LINE,
  PEEK_MIN,
  PEEK_PAD,
  PEEK_SPACE,
  peekLines,
  ROW,
  viewportHeight,
} from "#lib/composer-popup";
import { markRuns } from "#lib/composer-refs";
import { sizeText } from "#lib/files";
import { commandText, type SlashCommand, usageKey } from "#lib/slash";

import pinGlyph from "./composer-pin.svg";

/** The wait after the highlight rests before the bubble beside the list shows: never while the keys or the pointer run through rows. */
/** The slash list: room for a command and the start of what it does on one row. */
const COMMANDS_WIDTH = 440;
const BUBBLE_DELAY = 150;
/** The footer of keys under the files: one fixed row, always there. */
const KEYS_ROW = 24;
const PEEK_WIDTH = 360;
const TIP_WIDTH = 280;

const FADE = "from-popover/0 to-popover";
const FADE_SELECTED = "from-accent/0 to-accent";

/**
 * The list that opens from the message box: `@` files, `/` commands. One shell, so both look and move the same
 * (`design/composer.md`). It is an `Overlay` hung above the caret (the input reports where it is), so it covers no layout
 * and the box does not jump when it opens; the box keeps the keyboard focus and moves `highlighted`, a press on a row picks
 * it too. `children` are rows, each `ROW` tall.
 *
 * Nothing in it changes size while the highlight moves: the list is whole rows (at most `MAX_ROWS`) and hangs from its
 * bottom edge, so a shorter list moves only its top; what is said about the highlighted row is `bubble`, a second overlay
 * BESIDE the list (right, else left, kept inside the window by the core) that is no part of its layout. It is anchored to
 * the whole list, so its top is the list's top and a preview is as tall as the list, 8 pt away: above the box like the list,
 * never over it. It shows once the highlight has rested (`BUBBLE_DELAY`) and is cleared the moment the highlight moves.
 */
export function ComposerPicker(props: {
  label: string;
  anchor: Bounds | ViewRef | null;
  highlighted: number;
  /** How many rows `children` holds: the rows are all `ROW` tall, so this is all the reveal needs to know. */
  count: number;
  width: number;
  children: JSX.Element;
  /** The line of keys under the rows: `KEYS_ROW` high. */
  footer?: JSX.Element;
  /** Identifies what the bubble is about (the highlighted row's own key), or null for no bubble. */
  about?: string | null;
  /** Drawn beside the list, given the list's own height (fixed while it is open) so a preview can fill exactly that. */
  bubble?: (height: number) => JSX.Element;
  /** The least the bubble is tall (a short list grows it upward from the list's bottom edge): omit for a bubble that sizes itself. */
  bubbleMin?: number;
  bubbleWidth?: number;
}) {
  let scroll: ScrollRef | undefined;
  // The offset the person (or the last reveal) left the list at, from `onScroll`.
  const offset = signal(0);
  const frame = signal<Bounds | null>(null);
  // Whether the bubble is up. It waits for the highlight to rest only the first time; after that it stays while the
  // highlight moves and only its content follows, so moving through rows never blinks it away and back.
  const shown = signal(false);
  const viewport = () => viewportHeight(props.count);
  const box = () => bubbleBox(listHeight(), props.bubbleMin);
  // From the rows, not measured: the same number the list has (rows, the keys row, the 1 pt edge twice), known before the first frame.
  const listHeight = () => viewport() + (props.footer === undefined ? 0 : KEYS_ROW) + 2;
  // Move only when the highlighted row is out of view, and only as far as its edge.
  effect(() => {
    const rows = offsetsOf(Array.from({ length: props.count }, () => ROW));
    const y = revealOffset(rows, props.highlighted, untracked(offset), viewport());
    if (y === undefined) return;
    offset.set(y);
    scroll?.scrollTo({ y, animated: false });
  });
  const settle = createSettle(BUBBLE_DELAY, () => shown.set(true));
  cleanup(settle.cancel);
  effect(() => {
    const key = props.about;
    // Every change of row (or of what the row is) starts the wait again.
    void props.highlighted;
    untracked(() => {
      if (key === null || key === undefined) {
        settle.cancel();
        shown.set(false);
      } else if (!shown()) settle.move(key);
    });
  });
  return (
    <>
      <Overlay
        anchor={props.anchor}
        placement="top"
        align="start"
        offset={8}
        margin={8}
        onPosition={(p) => {
          const was = untracked(frame);
          const b = p.bounds;
          if (
            was === null ||
            was.origin.x !== b.origin.x ||
            was.origin.y !== b.origin.y ||
            was.size.width !== b.size.width ||
            was.size.height !== b.size.height
          )
            frame.set(b);
        }}
      >
        <View style={{ width: props.width }} class={`overflow-hidden rounded-lg bg-popover ${EDGE.md}`}>
          <View role="listbox" accessibilityLabel={props.label} style={{ height: viewport() }}>
            <Scroll
              ref={(node: ScrollRef) => {
                scroll = node;
              }}
              onScroll={(e) => {
                offset.set(e.offset.y);
              }}
            >
              {props.children}
            </Scroll>
          </View>
          {props.footer}
        </View>
      </Overlay>
      <If when={props.bubble !== undefined && props.about !== null && shown() && frame() !== null}>
        <Overlay
          anchor={frame()}
          placement="right"
          align={box().edge === "top" ? "start" : "end"}
          offset={BUBBLE_GAP}
          margin={8}
          style={{ pointerEvents: "none" }}
        >
          <View
            style={{ width: props.bubbleWidth ?? TIP_WIDTH }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {props.bubble?.(box().height)}
          </View>
        </Overlay>
      </If>
    </>
  );
}

/** One option of a picker: named for a screen reader as the row says it, drawn from its children. */
function PickerRow(props: { label: string; selected: boolean; onPress: () => void; children: JSX.Element }) {
  return (
    <Button
      role="option"
      accessibilityLabel={props.label}
      selected={props.selected}
      onPress={props.onPress}
      style={{ height: ROW }}
      class={`flex-row items-center gap-3 px-3 ${props.selected ? "bg-accent" : ""} ${FOCUS_RING_INSET}`}
    >
      {props.children}
    </Button>
  );
}

/** The accessible name of a file row: the path, its kind, and why it is near the top. */
export const mentionLabel = (hit: MentionView): string =>
  `${hit.path}${hit.folder ? ", folder" : ""}${hit.hot === "changed" ? ", changed" : hit.hot === "recent" ? ", recent" : ""}`;

/**
 * The files and folders a `@` can name: a shape for the kind, the name in medium weight with the letters the search matched
 * in bold, the folder after it (it fades first when the row is short of room, the name never), and a word (`changed`,
 * `recent`) where the list lifted a row: never a colour alone. The highlighted row's preview is a bubble beside the list;
 * the keys are the one fixed row under it.
 */
export function MentionList(props: {
  hits: MentionView[];
  highlighted: number;
  anchor: Bounds | ViewRef | null;
  peek: PeekView | null;
  onPick: (index: number) => void;
}) {
  const hit = () => props.hits[props.highlighted];
  return (
    <ComposerPicker
      label="Files"
      anchor={props.anchor}
      highlighted={props.highlighted}
      count={props.hits.length}
      width={460}
      about={hit()?.path ?? null}
      bubbleWidth={PEEK_WIDTH}
      bubbleMin={PEEK_MIN}
      bubble={(height) => <PeekBubble height={height} hit={hit()} peek={props.peek} />}
      footer={<KeysRow folder={hit()?.folder === true} />}
    >
      <Each of={props.hits} key="index">
        {(row, i) => (
          <PickerRow label={mentionLabel(row())} selected={i() === props.highlighted} onPress={() => props.onPick(i())}>
            <FileName
              name={row().name}
              folder={row().folder}
              hint={row().dir}
              strong
              tone="text-popover-foreground"
              fade={[i() === props.highlighted ? FADE_SELECTED : FADE]}
              hintChildren={
                <Each of={markRuns(row().path, row().marks, 0, row().dir.length)} key="index">
                  {(run) => <Text class={run().marked ? "font-bold" : ""}>{run().text}</Text>}
                </Each>
              }
            >
              <Each of={markRuns(row().path, row().marks, row().path.length - row().name.length)} key="index">
                {(run) => <Text class={run().marked ? "font-bold" : ""}>{run().text}</Text>}
              </Each>
            </FileName>
            <If when={row().hot !== undefined}>
              <Text class="shrink-0 text-xs text-muted-foreground">
                {row().hot === "changed" ? "changed" : "recent"}
              </Text>
            </If>
          </PickerRow>
        )}
      </Each>
    </ComposerPicker>
  );
}

/**
 * What the highlighted file looks like, in the list's own height: its name and size on one muted line, then as many whole
 * lines of mono 12 pt as fit (`peekLines`), each cut and faded at the edge. The size is the list's, so a late answer fills a
 * bubble that already has it and moves nothing; until then it is blank, with no spinner. A visible hairline is its edge
 * and its radius is the list's (`rounded-lg`); what sits inside it has no corner of its own to nest.
 */
function PeekBubble(props: { height: number; hit: MentionView | undefined; peek: PeekView | null }) {
  const kind = () => props.peek?.kind;
  return (
    <View
      style={{ height: props.height, padding: PEEK_PAD }}
      class="overflow-hidden rounded-lg border border-border bg-popover"
    >
      <View style={{ height: PEEK_HEAD }} class="flex-row items-center gap-3">
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
          {props.hit?.name ?? ""}
        </Text>
        <Text class="shrink-0 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
          {kind() === "folder"
            ? `${props.peek?.count ?? 0} ${props.peek?.count === 1 ? "item" : "items"}`
            : kind() === undefined
              ? ""
              : sizeText(props.peek?.size ?? 0)}
        </Text>
      </View>
      <View style={{ height: PEEK_SPACE }} />
      <If when={kind() === "text"}>
        <Each of={(props.peek?.lines ?? []).slice(0, peekLines(props.height))} key="index">
          {(line) => (
            <Clipped
              tip={false}
              fade={[FADE]}
              boxClass="h-[15px]"
              class="font-mono text-xs text-popover-foreground"
              style={{ lineHeight: PEEK_LINE }}
            >
              {line() === "" ? " " : line()}
            </Clipped>
          )}
        </Each>
      </If>
      <If when={kind() === "picture" && props.peek?.thumb !== undefined && props.peek?.thumb !== null}>
        <Image
          src={`data:image/jpeg;base64,${props.peek?.thumb ?? ""}`}
          style={{ width: 96, height: 96, borderRadius: 6, objectFit: "cover" }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </If>
      <If when={kind() === "binary"}>
        <Text class="text-xs text-muted-foreground">Not text</Text>
      </If>
    </View>
  );
}

/** The keys, one fixed row: always present, so the list is the same height with or without a preview. */
function KeysRow(props: { folder: boolean }) {
  return (
    <View style={{ height: KEYS_ROW }} class="flex-row items-center gap-3 border-t border-border px-3">
      <Hint keys="↑↓" what="move" />
      <Hint keys="Tab" what="add" />
      <If when={props.folder}>
        <Hint keys="→" what="open folder" />
      </If>
      <Hint keys="Esc" what="close" />
    </View>
  );
}

function Hint(props: { keys: string; what: string }) {
  return (
    <View
      class="flex-row items-center gap-1"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Keys keys={props.keys} />
      <Text class="text-xs text-muted-foreground">{props.what}</Text>
    </View>
  );
}

/**
 * The agent's own commands: the name, then what it does in the muted colour on the same row, faded at the edge; no
 * bubble beside the list (a bubble that follows the highlight flickers as the keys run through rows). The pin lives in a slot at the
 * row's right that is always there: a pinned command shows its glyph at rest (a pinned command also sorts first), any
 * other shows it only with the pointer or the focus on the row, so nothing moves.
 */
export function CommandList(props: {
  commands: SlashCommand[];
  highlighted: number;
  anchor: Bounds | ViewRef | null;
  pinned: (key: string) => boolean;
  onPick: (index: number) => void;
  onTogglePin: (command: SlashCommand) => void;
}) {
  return (
    <ComposerPicker
      label="Commands"
      anchor={props.anchor}
      highlighted={props.highlighted}
      count={props.commands.length}
      width={COMMANDS_WIDTH}
      about={null}
    >
      <Each of={props.commands} key="index">
        {(row, i) => (
          <View
            style={{ height: ROW }}
            class={`group flex-row items-center pr-1 ${i() === props.highlighted ? "bg-accent" : ""}`}
          >
            <Button
              role="option"
              accessibilityLabel={`${commandText(row())}${row().description ? `, ${row().description}` : ""}`}
              selected={i() === props.highlighted}
              onPress={() => props.onPick(i())}
              class={`h-full min-w-0 flex-1 flex-row items-center px-3 ${FOCUS_RING_INSET}`}
            >
              <Text class="shrink-0 text-sm font-medium text-popover-foreground" style={{ numberOfLines: 1 }}>
                {commandText(row())}
              </Text>
              <Clipped
                tip={false}
                fade={[i() === props.highlighted ? FADE_SELECTED : FADE]}
                boxClass="ml-3 min-w-0 flex-1"
                class="text-sm text-muted-foreground"
              >
                {row().description ?? ""}
              </Clipped>
            </Button>
            <Tipped label="Pin to the top">
              <Button
                accessibilityLabel={`${props.pinned(usageKey(row())) ? "Unpin" : "Pin"} ${commandText(row())}`}
                onPress={() => props.onTogglePin(row())}
                class={`size-7 items-center justify-center rounded-sm hover:bg-popover ${FOCUS_RING_INSET} ${
                  props.pinned(usageKey(row()))
                    ? "opacity-100"
                    : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                }`}
              >
                <Image
                  src={pinGlyph}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{ width: 14, height: 14, tintColor: token("muted-foreground") }}
                />
              </Button>
            </Tipped>
          </View>
        )}
      </Each>
    </ComposerPicker>
  );
}
