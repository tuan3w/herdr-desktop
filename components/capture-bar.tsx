import { announce, effect, keymap, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Herdr, PaneKeys } from "herdr-desktop/native";
import { captureKeystrokes } from "../lib/pane-input";
import { keyLabel } from "../lib/shortcuts";
import { Btn, dialogDepth, notify } from "./kit";

/**
 * Capture mode, on screen: the persistent hint bar and the field that hears the keyboard. It exists only while the
 * mode is on (its parent mounts it), so everything it binds goes away with it.
 *
 * How keys reach the pane: letters, digits, punctuation and pasted text arrive as typed text in the field, whatever the
 * keyboard layout or input method, and go through `Herdr.sendText`; every key that is not text (`captureKeystrokes`) is
 * bound and goes through `Herdr.sendKeys` under herdr's name for it (`PaneKeys.herdrKey`). Escape is one of those keys:
 * agents need it, so it is the pane's and never the way out. The way out is the global `capture` shortcut, which this
 * mode leaves alone, the `Leave` button, and moving the keyboard focus anywhere else: with the focus elsewhere the
 * field would no longer hear typing while the bound keys still went to the pane, so the mode ends instead, and says so.
 * While a dialog is open the keys are not bound at all, so the dialog's own Escape and Tab work.
 */
export function CaptureBar(props: { machine: string; pane: string; name: string; onLeave: () => void }) {
  const keys = captureKeystrokes();
  const leave = keyLabel("capture");

  const report = (e: unknown): void => {
    notify(`Could not type into the pane: ${e instanceof Error ? e.message : String(e)}`, { type: "error" });
  };
  // One request at a time, in the order typed: the engine runs each call on its own thread, so fired together `ls` could
  // reach the pane as `sl`. A failure is reported and does not stop what was typed after it.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (send: () => Promise<void>) => {
    queue = queue.then(send).catch(report);
  };
  const sendText = (text: string) => {
    if (text !== "") enqueue(() => Herdr.sendText(props.machine, props.pane, text));
  };

  effect(() => {
    if (dialogDepth() > 0) return;
    const handlers = Object.fromEntries(
      keys.map((k) => [
        k,
        ({ keystroke }: { keystroke: string }) => {
          const name = PaneKeys.herdrKey(keystroke);
          if (name !== null) enqueue(() => Herdr.sendKeys(props.machine, props.pane, [name]));
        },
      ]),
    );
    return keymap.bind(handlers, { when: "always", repeat: true });
  });

  announce(`Typing into ${props.name}. Press ${leave} to leave.`);

  // The field is never cleared: the keys that edit it (Backspace, arrows) are the pane's, so it only grows, and what is
  // new is what was typed since the last change.
  let before = "";
  return (
    <View
      role="group"
      accessibilityLabel={`Typing into ${props.name}`}
      class="flex-row items-center gap-3 border-t-2 border-primary bg-accent px-4 py-3"
    >
      <Text class="min-w-0 flex-1 text-sm font-medium text-accent-foreground">{`Typing into ${props.name} · ${leave} to leave`}</Text>
      <Input
        accessibilityLabel={`Keys go to ${props.name}`}
        accessibilityHint={`Everything you type goes to the pane. ${leave} leaves.`}
        autoFocus
        caret={false}
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        pasteBehavior="report"
        onPaste={(e) => sendText(e.text)}
        onChange={({ value }) => {
          sendText(value.startsWith(before) ? value.slice(before.length) : "");
          before = value;
        }}
        onBlur={props.onLeave}
        style={{ color: "transparent", width: 96, height: 24 }}
        class="rounded bg-transparent"
      />
      <Btn small label="Leave" name="Stop typing into the pane" onPress={props.onLeave} />
    </View>
  );
}
