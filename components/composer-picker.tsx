import { effect, Image, type JSX, Overlay, Scroll, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { MentionView, PeekView } from "herdr-desktop/native";
import type { Bounds, ScrollRef, ViewRef } from "nsh/types";

import { EDGE, FOCUS_RING_INSET, Icon, Kbd, offsetsOf, revealOffset } from "#kit";
import { fileGlyph, markRuns } from "#lib/composer-refs";
import { sizeText } from "#lib/files";
import { commandText, type SlashCommand, usageKey } from "#lib/slash";

/** One row's height in points: the list scrolls by whole rows to keep the highlighted one in view. */
const ROW = 32;
/** Rows visible at once. */
const VISIBLE = 8;
const WIDTH = 460;

/**
 * The list that opens from the message box: `@` files, `/` commands. One shell, so both look and move the same
 * (`design/composer.md`). It is an `Overlay` hung above the caret (the input reports where it is), so it covers no layout
 * and the box does not jump when it opens; the box keeps the keyboard focus and moves `highlighted`, a press on a row picks
 * it too. `children` are `PickerRow`s; `footer` is the line under them (a preview of the highlighted row).
 */
export function ComposerPicker(props: {
  label: string;
  anchor: Bounds | ViewRef | null;
  highlighted: number;
  /** How many rows `children` holds: the rows are all `ROW` tall, so this is all the reveal needs to know. */
  count: number;
  children: JSX.Element;
  footer?: JSX.Element;
}) {
  let scroll: ScrollRef | undefined;
  // The offset the person (or the last reveal) left the list at, from `onScroll`.
  let offset = 0;
  // Move only when the highlighted row is out of view, and only as far as its edge.
  effect(() => {
    const rows = offsetsOf(Array.from({ length: props.count }, () => ROW));
    const y = revealOffset(rows, props.highlighted, offset, ROW * VISIBLE);
    if (y === undefined) return;
    offset = y;
    scroll?.scrollTo({ y, animated: false });
  });
  return (
    <Overlay anchor={props.anchor} placement="top" align="start" offset={8} margin={8}>
      <View style={{ width: WIDTH }} class={`overflow-hidden rounded-lg bg-popover ${EDGE.md}`}>
        <View role="listbox" accessibilityLabel={props.label} style={{ maxHeight: ROW * VISIBLE }}>
          <Scroll
            ref={(node: ScrollRef) => {
              scroll = node;
            }}
            onScroll={(e) => {
              offset = e.offset.y;
            }}
          >
            {props.children}
          </Scroll>
        </View>
        {props.footer}
      </View>
    </Overlay>
  );
}

/** One option of a picker: named for a screen reader as the row says it, drawn from its children. */
export function PickerRow(props: { label: string; selected: boolean; onPress: () => void; children: JSX.Element }) {
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
 * in bold, the folder after it, and a word (`changed`, `recent`) where the list lifted a row: never a colour alone. The
 * highlighted row's preview and the keys are the footer.
 */
export function MentionList(props: {
  hits: MentionView[];
  highlighted: number;
  anchor: Bounds | ViewRef | null;
  peek: PeekView | null;
  onPick: (index: number) => void;
}) {
  return (
    <ComposerPicker
      label="Files"
      anchor={props.anchor}
      highlighted={props.highlighted}
      count={props.hits.length}
      footer={<MentionFooter hit={props.hits[props.highlighted]} peek={props.peek} />}
    >
      <Each of={props.hits} key="index">
        {(hit, i) => (
          <PickerRow label={mentionLabel(hit())} selected={i() === props.highlighted} onPress={() => props.onPick(i())}>
            <Icon name={fileGlyph(hit().name, hit().folder)} size={16} tone="muted-foreground" />
            <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
              <Text class="shrink-0 text-sm font-medium text-popover-foreground" style={{ numberOfLines: 1 }}>
                <Each of={markRuns(hit().path, hit().marks, hit().path.length - hit().name.length)} key="index">
                  {(run) => <Text class={run().marked ? "font-bold" : ""}>{run().text}</Text>}
                </Each>
                {hit().folder ? "/" : ""}
              </Text>
              <If when={hit().dir !== ""}>
                <Text
                  class="min-w-0 shrink text-xs text-muted-foreground"
                  style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
                >
                  <Each of={markRuns(hit().path, hit().marks, 0, hit().dir.length)} key="index">
                    {(run) => <Text class={run().marked ? "font-bold" : ""}>{run().text}</Text>}
                  </Each>
                </Text>
              </If>
            </View>
            <If when={hit().hot !== undefined}>
              <Text class="shrink-0 text-xs text-muted-foreground">
                {hit().hot === "changed" ? "changed" : "recent"}
              </Text>
            </If>
          </PickerRow>
        )}
      </Each>
    </ComposerPicker>
  );
}

/** What is under the keys: a line or two about the row, and the keys. */
function MentionFooter(props: { hit: MentionView | undefined; peek: PeekView | null }) {
  return (
    <View class="gap-1 border-t border-border px-3 py-2">
      <View class="min-h-8 flex-row items-center gap-3">
        <If when={props.peek?.thumb !== undefined && props.peek?.thumb !== null}>
          <View class="size-8 overflow-hidden rounded-sm bg-muted">
            <Image
              src={`data:image/jpeg;base64,${props.peek?.thumb ?? ""}`}
              style={{ width: 32, height: 32, objectFit: "cover" }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </View>
        </If>
        <View class="min-w-0 flex-1">
          <If when={props.peek === null}>
            <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
              {props.hit?.path ?? ""}
            </Text>
          </If>
          <If when={props.peek?.kind === "folder"}>
            <Text class="text-xs text-muted-foreground">
              {`${props.peek?.count ?? 0} ${props.peek?.count === 1 ? "item" : "items"}`}
            </Text>
          </If>
          <If when={props.peek?.kind === "picture"}>
            <Text class="text-xs text-muted-foreground">{`Picture, ${sizeText(props.peek?.size ?? 0)}`}</Text>
          </If>
          <If when={props.peek?.kind === "binary"}>
            <Text class="text-xs text-muted-foreground">{`${sizeText(props.peek?.size ?? 0)}, not text`}</Text>
          </If>
          <If when={props.peek?.kind === "text"}>
            <Each of={props.peek?.lines ?? []} key="index">
              {(line) => (
                <Text
                  class="font-mono text-xs text-muted-foreground"
                  style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
                >
                  {line()}
                </Text>
              )}
            </Each>
          </If>
        </View>
        <If when={props.peek?.kind === "text" || props.peek?.kind === "binary"}>
          <Text class="shrink-0 text-xs text-muted-foreground">{sizeText(props.peek?.size ?? 0)}</Text>
        </If>
      </View>
      <View class="flex-row items-center gap-3">
        <Hint keys="↑↓" what="move" />
        <Hint keys="Tab" what="add" />
        <If when={props.hit?.folder}>
          <Hint keys="→" what="open folder" />
        </If>
        <Hint keys="Esc" what="close" />
      </View>
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
      <Kbd keys={props.keys} />
      <Text class="text-xs text-muted-foreground">{props.what}</Text>
    </View>
  );
}

/** The agent's own commands, in the same list: the command, what it does, and `Pin` as the row's second action. */
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
    >
      <Each of={props.commands} key="index">
        {(command, i) => (
          <View
            style={{ height: ROW }}
            class={`flex-row items-center pr-1 ${i() === props.highlighted ? "bg-accent" : ""}`}
          >
            <Button
              role="option"
              accessibilityLabel={`${commandText(command())}${command().description ? `, ${command().description}` : ""}`}
              selected={i() === props.highlighted}
              onPress={() => props.onPick(i())}
              class={`h-full min-w-0 flex-1 flex-row items-center gap-3 px-3 ${FOCUS_RING_INSET}`}
            >
              <Text class="shrink-0 text-sm font-medium text-popover-foreground">{commandText(command())}</Text>
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
              <Text class="text-xs text-muted-foreground">{props.pinned(usageKey(command())) ? "Pinned" : "Pin"}</Text>
            </Button>
          </View>
        )}
      </Each>
    </ComposerPicker>
  );
}
