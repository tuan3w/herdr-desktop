import { computed, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";
import { CodeDiff } from "herdr-desktop/native";
import type { CodeDiffRef } from "herdr-desktop/native";
import { CODE_MAX_HEIGHT, diffLabel } from "#lib/highlight";
import { codeWhitespace, codeWrap, diffSplit } from "#lib/settings";
import { FOCUS_RING, Icon, Tipped } from "#kit";

/**
 * A file's change, drawn like a block of code: the file in the corner with `+3 −1` as words (the same counts the
 * screen reader hears), unified or side by side, the words that changed inside a line marked, long unchanged stretches
 * folded (press one), and every changed line carrying a `+` or `−` in its own column and a bar at its edge, so colour is
 * never the only signal. Both sides are syntax-highlighted. Give `oldText` and `newText` (a new file has an empty
 * `oldText`), or a `patch` of one file.
 *
 * Changes are reachable from the keyboard: `Previous change` and `Next change` are buttons in the header (Tab, Enter) and
 * step through the groups of changed lines, wrapping.
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
  /** Force a layout; by default the person's choice (`diffSplit`). */
  split?: boolean;
  /** The file is new: says so in the header. */
  created?: boolean;
  /** Makes the file name a button (`Open <path>`) that shows the file. */
  onOpenFile?: () => void;
}) {
  const counts = signal({ added: 0, removed: 0, changes: 0 });
  const at = signal<number | null>(null);
  let diff: CodeDiffRef | undefined;
  const split = () => props.split ?? diffSplit();
  const step = (dir: 1 | -1) => void (dir > 0 ? diff?.nextChange() : diff?.previousChange());
  const label = computed(() => diffLabel(props.path, counts().added, counts().removed));

  return (
    <View class="group w-full overflow-hidden rounded-md" style={{ backgroundColor: token("code-bg") }}>
      <View class="relative min-h-8 flex-row items-center gap-1 pl-3 pr-1">
        <If when={props.onOpenFile}>
          {(open) => (
            <Button onPress={open()} accessibilityLabel={`Open ${props.path}`} class={`min-w-0 flex-1 flex-row rounded-md py-1 ${FOCUS_RING}`}>
              <Text class="min-w-0 font-mono text-xs text-foreground underline" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
                {props.path ?? "Changes"}
              </Text>
            </Button>
          )}
        </If>
        <If when={!props.onOpenFile}>
          <Text class="min-w-0 flex-1 font-mono text-xs text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {props.path ?? "Changes"}
          </Text>
        </If>
        <If when={props.created}>
          <Text class="text-xs text-muted-foreground">new file</Text>
        </If>
        <Text class="pr-2 text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {`+${counts().added} \u2212${counts().removed}`}
        </Text>
        <View class="absolute right-1 top-1 flex-row items-center gap-1 rounded-md opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" style={{ backgroundColor: token("code-bg") }}>
          <Tool label="Previous change" icon="arrow-up" disabled={counts().changes === 0} onPress={() => step(-1)} />
          <Tool label="Next change" icon="chevron-down" disabled={counts().changes === 0} onPress={() => step(1)} />
          <Tool label="Side by side" text="Split" selected={split()} onPress={() => diffSplit.set(!split())} />
          <Tool label="Wrap lines" text="Wrap" selected={codeWrap()} onPress={() => codeWrap.set(!codeWrap())} />
        </View>
      </View>
      <CodeDiff
        ref={(ref: CodeDiffRef) => {
          diff = ref;
        }}
        oldText={props.oldText ?? ""}
        newText={props.newText ?? ""}
        patch={props.patch ?? ""}
        path={props.path}
        language={props.language}
        layout={split() ? "split" : "unified"}
        context={props.context ?? 3}
        wrap={codeWrap()}
        whitespace={codeWhitespace()}
        maxHeight={props.maxHeight ?? CODE_MAX_HEIGHT}
        label={label()}
        onCounts={(e: { added: number; removed: number; changes: number }) => counts.set(e)}
        onChange={(e: { index: number }) => at.set(e.index)}
      />
      <If when={counts().changes > 1 && at() !== null}>
        <Text class="px-3 py-1 text-xs text-muted-foreground">{`Change ${(at() ?? 0) + 1} of ${counts().changes}`}</Text>
      </If>
    </View>
  );
}

function Tool(props: { label: string; onPress: () => void; text?: string; icon?: "arrow-up" | "chevron-down"; selected?: boolean; disabled?: boolean }) {
  return (
    <Tipped label={props.label}>
      <Button
        onPress={props.onPress}
        accessibilityLabel={props.label}
        selected={props.selected}
        disabled={props.disabled}
        class={`min-h-7 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent selected:bg-accent ${FOCUS_RING}`}
      >
        <If when={props.icon}>{(name) => <Icon name={name()} size={14} tone="muted-foreground" />}</If>
        <If when={props.text}>
          <Text class="text-xs text-muted-foreground">{props.text}</Text>
        </If>
      </Button>
    </Tipped>
  );
}
