import { Text, View } from "nsh";

import type { DiffItem } from "herdr-desktop/native";

import { DiffBlock } from "#components/diff-block";
import { visibleText } from "#lib/visible-text";

/** The tallest one file's diff grows before it scrolls inside itself, in points. */
const MAX_HEIGHT = 200;
/** Files shown before the rest is counted: a request that edits a dozen files is read in the transcript's tool row. */
const MAX_FILES = 4;

/**
 * The edits a request is about to make, as the agent sent them: one diff per file (`DiffBlock`: its path and its counts
 * as words, the words that changed marked, the `+` and `−` in a column of their own, so the amount is not only a colour).
 * Read only; each diff scrolls inside its own box.
 */
export function PermissionDiff(props: { diffs: readonly DiffItem[] }) {
  const shown = () => props.diffs.slice(0, MAX_FILES);
  return (
    <View role="group" accessibilityLabel="Changes this request makes" class="gap-2">
      <Each of={shown()} key={(d: DiffItem) => d.path}>
        {(diff) => (
          <DiffBlock
            path={visibleText(diff().path)}
            oldText={diff().old ?? ""}
            newText={diff().new}
            created={diff().old == null}
            context={2}
            maxHeight={MAX_HEIGHT}
          />
        )}
      </Each>
      <If when={props.diffs.length > MAX_FILES}>
        <Text class="text-xs text-muted-foreground">{`${props.diffs.length - MAX_FILES} more files: see the transcript`}</Text>
      </If>
    </View>
  );
}
