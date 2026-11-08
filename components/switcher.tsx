import { computed, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Command, type CommandItem, type CommandRef } from "nsh/base";

import { Monogram } from "#components/project-parts";
import { StatusGlyph } from "#components/status-glyph";
import { Clipped, Modal } from "#kit";
import {
  onSwitcherStep,
  openSwitcherItem,
  type SwitcherItem,
  switcherItems,
  switcherPlaces,
  type SwitcherPlaces,
  switcherStart,
} from "#lib/nav";
import { keyLabel } from "#lib/shortcuts";
import { fold } from "#lib/text";

/**
 * The Switcher: the places visited last (agents and projects), newest first, in the palette's modal. It opens on
 * `mod+e` with the second row highlighted (the one to go back to; the first is where you are), `mod+e` again moves down
 * and `mod+shift+e` up, Enter opens, Escape returns to where you were. Typing narrows the list.
 *
 * The rows are fixed when it opens: what is listed and in which order never changes while it is open, so a row is where
 * the eyes left it (what a row says, its shape and age, stays live). It is the answer to "where was I", so it is calm:
 * the quiet shape and a muted word, never the signal colour (`design/attention.md`). A screen reader hears the whole row
 * and, in the footer, the place in the list.
 */
export function Switcher(props: { open: boolean; onClose: () => void }) {
  const query = signal("");
  const places = signal<SwitcherPlaces>({ ids: [], here: null });
  const highlighted = signal<string | null>(null);
  let command: CommandRef | undefined;

  const items = computed(() => switcherItems(places()));
  const shown = computed(() => {
    const words = fold(query()).split(/\s+/).filter(Boolean);
    return items().filter((i) => words.every((w) => fold(`${i.title} ${i.meta}`).includes(w)));
  });
  const byId = computed(() => new Map(items().map((i) => [i.id, i])));
  const position = () => {
    const at = shown().findIndex((i) => i.id === highlighted());
    return at < 0 ? "" : `${at + 1} of ${shown().length}`;
  };
  const commands = computed<CommandItem[]>(() =>
    shown().map((i, at) => ({ id: i.id, label: `${i.spoken}, ${at + 1} of ${shown().length}` })),
  );

  const move = (step: 1 | -1) => {
    const list = shown();
    if (list.length === 0) return;
    const at = list.findIndex((i) => i.id === highlighted());
    command?.highlight(list[(at + step + list.length) % list.length].id);
  };

  // Opening takes the places once; the highlight starts on the way back (row two) or, going up, on the last row.
  effect(() => {
    if (!props.open) {
      onSwitcherStep(undefined);
      return;
    }
    untracked(() => {
      places.set(switcherPlaces());
      query.set("");
      highlighted.set(null);
    });
    onSwitcherStep(move);
    setTimeout(() => {
      const list = shown();
      const start = switcherStart() === 1 ? (list[1] ?? list[0]) : list.at(-1);
      if (start) command?.highlight(start.id);
    }, 0);
  });

  const choose = (id: string, here = false) => {
    const item = byId().get(id);
    props.onClose();
    if (item) void openSwitcherItem(item, { here });
  };

  // Shift+Enter opens the highlighted agent here, in the workspace shown, instead of in its project's.
  effect(() => {
    if (!props.open) return;
    return keymap.bind(
      { "shift+enter": () => highlighted() !== null && choose(highlighted()!, true) },
      { when: "always" },
    );
  });

  return (
    <Modal open={props.open} onClose={() => props.onClose()} title="Switch to…">
      <View class="gap-2">
        <Command
          ref={(ref) => (command = ref)}
          items={commands()}
          query={query()}
          autoFocus
          accessibilityLabel="Recent agents and projects"
          searchAccessibilityLabel="Filter recent agents and projects"
          placeholder="Filter"
          searchBarClass="mb-2 rounded-md border border-border px-3"
          searchClass="h-8 text-sm"
          listClass="max-h-[360px]"
          itemClass="group flex-row items-center rounded-md px-3 py-2 focus:bg-accent hover:bg-accent"
          renderItem={(entry) => <Row item={() => byId().get(entry.id)} />}
          onQueryChange={({ query: q }) => query.set(q)}
          onHighlightChange={({ highlighted: id }) => highlighted.set(id)}
          onSelect={({ id }) => choose(id)}
          onCancel={() => props.onClose()}
          empty={
            <Text class="px-3 py-4 text-sm text-muted-foreground">
              {items().length === 0 ? "Nothing visited yet: agents you open are listed here." : "Nothing matches"}
            </Text>
          }
          footer={
            <View class="flex-row items-center gap-3 px-3 pt-3">
              <Text class="flex-1 text-xs text-muted-foreground">{`Enter opens · Shift+Enter opens here · Esc goes back · ${keyLabel("switcher")} next`}</Text>
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                class="text-xs text-muted-foreground"
              >
                {position()}
              </Text>
            </View>
          }
        />
      </View>
    </Modal>
  );
}

/** One row: the agent's shape (a project's tile), its name, the muted line, and after the name the age or `here`. */
function Row(props: { item: () => SwitcherItem | undefined }) {
  const kind = () => props.item()?.kind;
  return (
    <View class="min-w-0 flex-1 flex-row items-center gap-3">
      <View class="w-8 items-center">
        <If
          when={kind() === "project"}
          else={<StatusGlyph status={props.item()?.status ?? "unknown"} id={props.item()?.id} />}
        >
          <Monogram name={props.item()?.title ?? ""} size={24} />
        </If>
      </View>
      <View class="min-w-0 flex-1">
        <View class="flex-row items-center gap-2">
          <Clipped class="min-w-0 shrink text-sm font-medium text-foreground">{props.item()?.title ?? ""}</Clipped>
          <Text class="text-xs text-muted-foreground">{props.item()?.here ? "here" : (props.item()?.age ?? "")}</Text>
        </View>
        <Clipped class="text-xs text-muted-foreground">
          {[props.item()?.word, props.item()?.meta].filter(Boolean).join(" · ")}
        </Clipped>
      </View>
    </View>
  );
}
