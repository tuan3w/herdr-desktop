import { announce, computed, signal, Text, View } from "nsh";
import { Command, type CommandItem, type CommandRef } from "nsh/base";
import { Kbd, Modal } from "#kit";

/** One thing the palette can run. `shortcut` is a `keymap` key shown beside it (the app binds it elsewhere). */
export type PaletteItem = CommandItem;

/**
 * The command palette: a search field over every action of the app, in a modal. Opens on `mod+k`, Up and Down move,
 * Enter runs, Escape clears the query and then closes. The number of matches is announced after each query so a
 * screen reader user hears how many results there are without leaving the field.
 *
 * `onRun` gets the item id after the palette closed (so what it opens can take the focus).
 */
export function Palette(props: { open: boolean; onClose: () => void; items: PaletteItem[]; onRun: (id: string) => void }) {
  const query = signal("");
  // The list shows a heading where the group changes, so one group must be one run: groups keep the order they first appear in.
  const grouped = computed(() => {
    const order = [...new Set(props.items.map((i) => i.group ?? ""))];
    return [...props.items].sort((a, b) => order.indexOf(a.group ?? "") - order.indexOf(b.group ?? ""));
  });
  let command: CommandRef | undefined;
  const count = async () => {
    const n = await command?.matchedCount();
    if (n !== undefined) announce(n === 1 ? "1 result" : `${n} results`);
  };
  return (
    <Modal open={props.open} onClose={() => props.onClose()} title="Command palette">
      <View class="gap-2">
        <Command
          ref={(ref) => (command = ref)}
          items={grouped()}
          query={query()}
          autoFocus
          accessibilityLabel="Commands"
          searchAccessibilityLabel="Search commands"
          placeholder="Type a command"
          searchBarClass="mb-2 rounded-md border border-border px-3"
          searchClass="h-9 text-sm"
          listClass="max-h-[320px]"
          itemClass="group flex-row items-center rounded-md px-3 py-2 focus:bg-accent hover:bg-accent disabled:opacity-50"
          groupClass="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground"
          renderItem={(item) => (
            <View class="flex-1 flex-row items-center gap-3">
              <Text class="flex-1 text-sm text-foreground">{item.label}</Text>
              <If when={item.shortcutLabel}>
                <Kbd keys={item.shortcutLabel ?? ""} />
              </If>
            </View>
          )}
          onQueryChange={({ query: q }) => {
            query.set(q);
            void count();
          }}
          onSelect={({ id }) => {
            query.set("");
            props.onClose();
            props.onRun(id);
          }}
          onCancel={() => {
            query.set("");
            props.onClose();
          }}
          empty={<Text class="px-3 py-4 text-sm text-muted-foreground">No command matches</Text>}
        />
      </View>
    </Modal>
  );
}
