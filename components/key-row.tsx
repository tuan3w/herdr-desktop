import { View } from "nsh";
import { Btn } from "./kit";

interface Press {
  label: string;
  /** What a screen reader says, when the label alone is a symbol. */
  name: string;
  /** herdr key names pressed in the pane. */
  keys?: string[];
  /** Text put into the message box instead of the pane (a `/` starts the command list there). */
  insert?: string;
}

const key = (label: string, keys: string, name = label): Press => ({ label, name, keys: [keys] });
const insert = (label: string): Press => ({ label, name: `Insert ${label}`, insert: label });

const ARROWS = [key("Up", "up"), key("Down", "down"), key("Left", "left"), key("Right", "right")];

/** What an agent's prompt takes: Space toggles a checkbox row, `/` and `@` start a command or a file mention. */
const AGENT: Press[] = [
  key("Esc", "esc"),
  ...ARROWS,
  key("Enter", "enter"),
  key("Space", "space"),
  key("Tab", "tab"),
  key("Shift+Tab", "shift+tab"),
  key("Ctrl+C", "ctrl+c"),
  insert("/"),
  insert("@"),
];

/** A shell has no `@` mention but needs Ctrl+D and the symbols that are far from the hands. */
const SHELL: Press[] = [
  key("Esc", "esc"),
  ...ARROWS,
  key("Enter", "enter"),
  key("Tab", "tab"),
  key("Ctrl+C", "ctrl+c"),
  key("Ctrl+D", "ctrl+d"),
  insert("/"),
  insert("~"),
  insert("-"),
  insert("|"),
];

/** The keys of a pane's key row, by what the pane runs (exported for the tests). */
export const keysFor = (agent: boolean): Press[] => (agent ? AGENT : SHELL);

/**
 * The keys a message box cannot type, one press each: `Herdr.sendKeys` for a key, the message box for a symbol. A
 * desktop keyboard has them all; the row is for the pointer, and capture mode is for the keyboard. Disabled while
 * the machine is not connected.
 */
export function KeyRow(props: { agent: boolean; disabled: boolean; onKeys: (keys: string[]) => void; onInsert: (text: string) => void }) {
  return (
    <View role="toolbar" accessibilityLabel="Keys" class="flex-row flex-wrap gap-1.5 border-t border-border bg-card px-3 py-1.5">
      <Each of={keysFor(props.agent)} key={(p: Press) => p.name}>
        {(press) => (
          <Btn
            small
            label={press().label}
            name={press().name}
            disabled={props.disabled}
            onPress={() => {
              const p = press();
              if (p.keys) props.onKeys(p.keys);
              else if (p.insert) props.onInsert(p.insert);
            }}
          />
        )}
      </Each>
    </View>
  );
}
