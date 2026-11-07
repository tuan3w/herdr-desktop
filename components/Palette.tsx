import { announce, signal, Text, View } from "nsh";
import { Command, type CommandItem, type CommandRef } from "nsh/base";
import { Modal } from "./kit";

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
          items={props.items}
          query={query()}
          autoFocus
          accessibilityLabel="Commands"
          searchAccessibilityLabel="Search commands"
          placeholder="Type a command"
          listClass="max-h-[320px]"
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
