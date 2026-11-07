import { announce, effect, keymap, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { InputRef } from "nsh/types";
import { matchRows } from "#lib/pane-input";
import { Btn, IconButton, INPUT_CLASS } from "#kit";

/**
 * The find bar over the rows the mirror shows (`mod+f`). Enter goes to the next match down the pane, Shift+Enter to
 * the one before, Escape closes it. It starts at the last match, the one nearest the newest output. The rows are read
 * again at every query and every step, so output that arrived meanwhile is found; the count is announced politely.
 */
export function PaneFind(props: { rows: () => Promise<string[]>; scrollToRow: (row: number) => void; onClose: () => void; /** What is searched, for the field's name: `pane` (default) or `file`. */ what?: string }) {
  const what = props.what ?? "pane";
  const query = signal("");
  const hits = signal<number[]>([]);
  const at = signal(0);
  const focused = signal(false);
  let field: InputRef | undefined;
  let latest = 0;

  const say = () => {
    if (query().trim() === "") return;
    announce(hits().length === 0 ? "No matches" : `${at() + 1} of ${hits().length}`);
  };
  const show = (i: number) => {
    at.set(i);
    props.scrollToRow(hits()[i]);
    say();
  };
  // Reads the rows now and re-finds the matches; the current one stays when its row still matches (`keep`), else it is the last.
  // Resolves false when a newer read replaced this one.
  const refresh = async (keep: boolean): Promise<boolean> => {
    const mine = ++latest;
    const found = matchRows(await props.rows(), query());
    if (mine !== latest) return false;
    const previous = keep ? hits()[at()] : undefined;
    hits.set(found);
    at.set(Math.max(0, previous === undefined ? found.length - 1 : found.indexOf(previous) >= 0 ? found.indexOf(previous) : found.length - 1));
    return true;
  };
  const typed = async () => {
    if (!(await refresh(false))) return;
    if (hits().length > 0) show(at());
    else say();
  };
  const step = async (by: 1 | -1) => {
    if (!(await refresh(true)) || hits().length === 0) return;
    show((at() + by + hits().length) % hits().length);
  };

  effect(() => {
    if (!focused()) return;
    return keymap.bind(
      {
        "shift+enter": () => void step(-1),
        escape: () => props.onClose(),
      },
      { when: "always" },
    );
  });

  return (
    <View class="flex-row items-center gap-2 border-b border-border bg-card px-3 py-2">
      <Input
        ref={(node: InputRef) => {
          field = node;
        }}
        value={query()}
        onChange={({ value }) => {
          query.set(value);
          void typed();
        }}
        placeholder={`Find in the ${what}`}
        accessibilityLabel={`Text to find in the ${what}`}
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        submitBehavior="submit"
        onSubmit={() => void step(1)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        class={`${INPUT_CLASS} w-64`}
      />
      <Text class="min-w-24 text-xs text-muted-foreground">
        {query().trim() === "" ? "" : hits().length === 0 ? "No matches" : `${at() + 1} of ${hits().length}`}
      </Text>
      <Btn small label="Previous" name="Previous match" disabled={hits().length === 0} onPress={() => void step(-1).then(() => field?.focus())} />
      <Btn small label="Next" name="Next match" disabled={hits().length === 0} onPress={() => void step(1).then(() => field?.focus())} />
      <View class="flex-1" />
      <IconButton icon="x" label="Close find" onPress={props.onClose} />
    </View>
  );
}
