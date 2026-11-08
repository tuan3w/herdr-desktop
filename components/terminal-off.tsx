import { Herdr } from "herdr-desktop/native";
import { announce, Text, View } from "nsh";

import { Btn, copyText, Empty } from "#kit";
import { meta } from "#lib/herdr";
import { canShowChat, showChat } from "#lib/open-agent";
import { terminalEnabled } from "#lib/settings";
import { herdrClientCommand } from "#lib/terminal-command";

/**
 * The client command as a person types it in their own terminal: `herdrClientCommand`'s line without what only a launcher
 * needs (the `PATH` hint and `exec`), so `herdr`, `herdr --session 'work'` or `herdr --remote 'me@box'`. `null` when the
 * machine is unknown or its command cannot be built.
 */
export function attachCommand(machine: string): string | null {
  const at = Herdr.machines().find((m) => m.id === machine);
  if (!at) return null;
  const made = herdrClientCommand({ local: at.local, dest: at.dest, port: at.port, session: at.session });
  return "command" in made ? made.command.replace(/^(?:PATH=\S+ )?exec /, "") : null;
}

/**
 * A terminal tab while the terminal tab is off in Settings (`terminalEnabled`): it never mounts the native `Terminal`
 * (with one open, switching to the Board could send nsh's reactive runtime into a loop, `docs/STATUS.md`). It says once
 * what to do instead: the exact command that attaches herdr in the person's own terminal, selectable and with `Copy`;
 * `Show chat` for an agent whose log can be read (a tab restored from an older layout); and the way to turn the tab on,
 * after which the tab reads `Press Return to reconnect` (nothing attaches by itself, `isArmed`).
 */
export function TerminalOff(props: { machine: string; pane: string }) {
  const info = meta(props.machine, props.pane);
  const name = () => info()?.name ?? props.pane;
  const command = () => attachCommand(props.machine);
  const chat = () => canShowChat(props.machine, props.pane);
  const turnOn = () => {
    terminalEnabled.set(true);
    announce("Terminal tab on. Press Return to reconnect.");
  };
  return (
    <View class="min-h-0 flex-1 bg-background">
      <Empty
        fill
        icon="terminal"
        title={name()}
        hint={
          chat()
            ? "The terminal tab is off. Read this agent as a chat, or open it in your terminal:"
            : "This agent has no chat here. Open it in your terminal:"
        }
      >
        <If
          when={command()}
          else={<Text class="text-sm text-muted-foreground">herdr does not know this machine any more.</Text>}
        >
          {(line) => (
            <View class="mt-1 max-w-full flex-row items-center gap-2 rounded-md border border-border bg-muted py-1 pr-1 pl-3">
              <Text class="min-w-0 shrink font-mono text-sm text-foreground" style={{ userSelect: "text" }}>
                {line()}
              </Text>
              <Btn
                small
                variant="ghost"
                icon="copy"
                label="Copy"
                name="Copy command"
                onPress={() => void copyText(line(), "Command")}
              />
            </View>
          )}
        </If>
        <View class="mt-2 flex-row flex-wrap justify-center gap-2">
          <If when={chat()}>
            <Btn
              label="Show chat"
              name="Show chat"
              icon="message"
              onPress={() => void showChat(props.machine, props.pane)}
            />
          </If>
          <Btn variant="ghost" label="Turn on the terminal tab" name="Turn on the terminal tab" onPress={turnOn} />
        </View>
      </Empty>
    </View>
  );
}
