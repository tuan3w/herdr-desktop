import { Text, View } from "nsh";
import { DiffView } from "nsh/base";
import type { DiffItem } from "herdr-desktop/native";
import { visibleText } from "../lib/visible-text";

/** A row of the diff, in points: the view is virtual and needs the height it may take. */
const ROW = 20;
/** The tallest one file's diff grows before it scrolls inside itself. */
const MAX_ROWS = 10;
/** Files shown before the rest is counted: a request that edits a dozen files is read in the transcript's tool row. */
const MAX_FILES = 4;

/** Rows the diff of one file needs: its changes and the context around them, no more than the file has, and not past the cap. */
function rows(diff: DiffItem): number {
  const inFile = diff.new.split("\n").length + diff.removed;
  return Math.max(2, Math.min(MAX_ROWS, inFile, diff.added + diff.removed + 4));
}

/**
 * The edits a request is about to make, as the agent sent them: one unified diff per file with its path and its counts
 * as words (`+3 −1`), so the amount is not only a colour. Read only; each diff scrolls inside its own box.
 */
export function PermissionDiff(props: { diffs: readonly DiffItem[] }) {
  const shown = () => props.diffs.slice(0, MAX_FILES);
  return (
    <View role="group" accessibilityLabel="Changes this request makes" class="gap-2">
      <Each of={shown()} key={(d: DiffItem) => d.path}>
        {(diff) => (
          <View class="gap-1">
            <View class="flex-row items-baseline justify-between gap-3">
              <Text style={{ userSelect: "text" }} class="min-w-0 flex-1 font-mono text-xs text-foreground">
                {visibleText(diff().path)}
              </Text>
              <Text class="text-xs text-muted-foreground">{`+${diff().added} −${diff().removed}`}</Text>
            </View>
            <View class="overflow-hidden rounded-md border border-border" style={{ height: rows(diff()) * ROW }}>
              <DiffView
                oldValue={diff().old ?? ""}
                newValue={diff().new}
                language={diff().path}
                layout="unified"
                contextLines={2}
                lineHeight={ROW}
                fontSize={12}
                softWrap
                class="flex-1"
              />
            </View>
          </View>
        )}
      </Each>
      <If when={props.diffs.length > MAX_FILES}>
        <Text class="text-xs text-muted-foreground">{`${props.diffs.length - MAX_FILES} more files: see the transcript`}</Text>
      </If>
    </View>
  );
}
