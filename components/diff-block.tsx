import { CodeDiff } from "herdr-desktop/native";
import { cleanup, computed, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";

import type { CodeDiffRef } from "herdr-desktop/native";

import { CodeTools } from "#components/code-tools";
import { copyMenu, copyText, FOCUS_RING, IconButton } from "#kit";
import { CODE_MAX_HEIGHT, diffLabel } from "#lib/highlight";
import { codeWhitespace, codeWrap, diffSplit } from "#lib/settings";

/** Where the change in view stands: `Change 2 of 5`, or how many there are before the first step (`5 changes`); nothing when none. */
export function changeText(at: number | null, total: number): string {
  if (total === 0) return "";
  if (at === null || total === 1) return `${total} ${total === 1 ? "change" : "changes"}`;
  return `Change ${at + 1} of ${total}`;
}

/**
 * A file's change, drawn like a block of code: the file in the corner with `+3 −1` as words (the same counts the
 * screen reader hears), unified or side by side, the words that changed inside a line marked, long unchanged stretches
 * folded (press one), and every changed line carrying a `+` or `−` in its own column and a bar at its edge, so colour is
 * never the only signal. Both sides are syntax-highlighted. Give `oldText` and `newText` (a new file has an empty
 * `oldText`), or a `patch` of one file.
 *
 * Changes are reachable from the keyboard: `Previous change` and `Next change` are buttons in the header (Tab, Enter), always
 * drawn, and step through the groups of changed lines, wrapping; the header says which one is in view.
 */
export function DiffBlock(props: {
  /** The file's path as shown and as the language's source. */
  path?: string;
  oldText?: string;
  newText?: string;
  patch?: string;
  /** A language name when `path` does not say it. */
  language?: string;
  /** Unchanged lines kept around a change (default 3). */
  context?: number;
  maxHeight?: number;
  /** On the page's colour inside a hairline box, not on the code surface: for a diff in a card (a step). */
  flat?: boolean;
  /** Force a layout; by default the person's choice (`diffSplit`). */
  split?: boolean;
  /** Force wrapping on or off; by default the person's choice (`codeWrap`). A narrow pane turns it off so the code scrolls sideways. */
  wrap?: boolean;
  /** The file is new: the header says so once, and its lines are drawn as plain code (no tint, bar or sign on every row). */
  created?: boolean;
  /** Draw the file's path in the header (default). A screen that already names the file elsewhere turns it off. */
  showPath?: boolean;
  /** Makes the file name a button (`Open <path>`) that shows the file. */
  onOpenFile?: () => void;
  /** Hands over the steps `Previous change` and `Next change` take, once drawn (`null` when the block goes), for a screen with keys of its own. */
  onReady?: (steps: { next(): void; previous(): void } | null) => void;
  /** The group of changes brought into view, from 0: by a step, or by a key of the screen's. */
  onChange?: (index: number) => void;
}) {
  const counts = signal({ added: 0, removed: 0, changes: 0 });
  const at = signal<number | null>(null);
  let diff: CodeDiffRef | undefined;
  const split = () => props.split ?? diffSplit();
  const step = (dir: 1 | -1) => void (dir > 0 ? diff?.nextChange() : diff?.previousChange());
  cleanup(() => props.onReady?.(null));
  const label = computed(() => diffLabel(props.path, counts().added, counts().removed));

  return (
    <View
      class={`group w-full overflow-hidden rounded-md ${props.flat ? "border border-border" : ""}`}
      style={props.flat ? undefined : { backgroundColor: token("code-bg") }}
      onContextMenu={copyMenu(() =>
        [
          props.patch ? { label: "Copy patch", onSelect: () => void copyText(props.patch ?? "", "Patch") } : undefined,
          props.newText !== undefined
            ? { label: "Copy new version", onSelect: () => void copyText(props.newText ?? "", "New version") }
            : undefined,
        ].filter((e) => e !== undefined),
      )}
    >
      <View class="relative min-h-8 flex-row items-center gap-1 pl-3 pr-1">
        <If when={props.showPath !== false ? props.onOpenFile : undefined}>
          {(open) => (
            <Button
              onPress={open()}
              accessibilityLabel={`Open ${props.path}`}
              class={`min-w-0 flex-1 flex-row rounded-md py-1 ${FOCUS_RING}`}
            >
              <Text
                class="min-w-0 font-mono text-xs text-foreground underline"
                style={{ numberOfLines: 1, textOverflow: "ellipsis", userSelect: "none" }}
              >
                {props.path ?? "Changes"}
              </Text>
            </Button>
          )}
        </If>
        <If when={props.showPath !== false && !props.onOpenFile}>
          <Text
            class="min-w-0 flex-1 font-mono text-xs text-foreground"
            style={{ numberOfLines: 1, textOverflow: "ellipsis", userSelect: "none" }}
          >
            {props.path ?? "Changes"}
          </Text>
        </If>
        <If when={props.showPath === false}>
          <View class="min-w-0 flex-1" />
        </If>
        <If when={props.created}>
          <Text class="text-xs text-muted-foreground" style={{ userSelect: "none" }}>
            new file
          </Text>
        </If>
        <Text class="text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"], userSelect: "none" }}>
          {changeText(at(), counts().changes)}
        </Text>
        <Text class="pr-2 text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"], userSelect: "none" }}>
          {`+${counts().added} \u2212${counts().removed}`}
        </Text>
        <CodeTools
          label="Diff options"
          entries={[
            ...(props.created
              ? []
              : [
                  {
                    type: "checkbox" as const,
                    label: "Side by side",
                    checked: split(),
                    onCheckedChange: (on: boolean) => diffSplit.set(on),
                  },
                ]),
            {
              type: "checkbox",
              label: "Wrap lines",
              checked: codeWrap(),
              onCheckedChange: (on: boolean) => codeWrap.set(on),
            },
          ]}
        >
          <IconButton
            icon="arrow-up"
            label="Previous change"
            disabled={counts().changes === 0}
            onPress={() => step(-1)}
            tipSide="top"
          />
          <IconButton
            icon="chevron-down"
            label="Next change"
            disabled={counts().changes === 0}
            onPress={() => step(1)}
            tipSide="top"
          />
        </CodeTools>
      </View>
      <CodeDiff
        ref={(ref: CodeDiffRef) => {
          diff = ref;
          props.onReady?.({ next: () => step(1), previous: () => step(-1) });
        }}
        oldText={props.oldText ?? ""}
        newText={props.newText ?? ""}
        patch={props.patch ?? ""}
        path={props.path}
        language={props.language}
        layout={props.created ? "code" : split() ? "split" : "unified"}
        context={props.context ?? 3}
        wrap={props.wrap ?? codeWrap()}
        whitespace={codeWhitespace()}
        maxHeight={props.maxHeight ?? CODE_MAX_HEIGHT}
        flat={props.flat}
        label={label()}
        onCounts={(e: { added: number; removed: number; changes: number }) => counts.set(e)}
        onChange={(e: { index: number }) => {
          at.set(e.index);
          props.onChange?.(e.index);
        }}
      />
    </View>
  );
}
