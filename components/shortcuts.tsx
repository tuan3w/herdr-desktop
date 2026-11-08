import { Text, View } from "nsh";

import { Btn, Keys, Modal } from "#kit";
import { type Group, GROUPS, keysOf, keyText, listedShortcuts, type Shortcut } from "#lib/shortcuts";

/** One line: what it does, its keys at the right edge. Read as one sentence ("New agent session: Ctrl+N"), since keycaps are decorative. */
function Row(props: { shortcut: Shortcut }) {
  const keys = () => keysOf(props.shortcut).map(keyText);
  return (
    <View
      accessibilityLabel={`${props.shortcut.label}: ${keys().join(", ")}`}
      class="h-8 flex-row items-center justify-between gap-3"
    >
      <Text class="min-w-0 line-clamp-1 flex-1 text-sm text-foreground">{props.shortcut.label}</Text>
      <View class="shrink-0 flex-row items-center gap-2">
        <Each of={keys()} key={(k: string) => k}>
          {(k) => <Keys keys={k()} />}
        </Each>
      </View>
    </View>
  );
}

/**
 * Every shortcut in one place (a global key, or `View` in Settings). Three levels, read left to right and top to bottom:
 * the group's name in a quiet rail at the left, its shortcuts beside it, a hairline between groups. The list is
 * `lib/shortcuts.ts`, so it cannot fall behind the app.
 */
export function Shortcuts(props: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Keyboard shortcuts"
      actions={<Btn label="Close" hint={keyText("escape")} onPress={props.onClose} />}
    >
      <View>
        <Each of={GROUPS} key={(g: Group) => g.id}>
          {(g, index) => (
            <View class={`flex-row gap-4 pb-3 ${index() > 0 ? "border-t border-border pt-3" : ""}`}>
              <Text role="header" class="w-32 shrink-0 pt-2 text-xs font-medium text-muted-foreground">
                {g().title}
              </Text>
              <View class="min-w-0 flex-1">
                <Each of={listedShortcuts().filter((s) => s.group === g().id)} key={(s: Shortcut) => s.label}>
                  {(s) => <Row shortcut={s()} />}
                </Each>
              </View>
            </View>
          )}
        </Each>
      </View>
    </Modal>
  );
}
