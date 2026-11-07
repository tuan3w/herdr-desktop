import { Text, View } from "nsh";

import type { PaneMeta } from "herdr-desktop/native";

import { agentTitle } from "#components/composer";
import { StatusGlyph } from "#components/status-glyph";
import { ActionMenu, Btn, Clipped, IconButton, type MenuEntry } from "#kit";
import { keyLabel } from "#lib/shortcuts";
import { statusText } from "#lib/status";

/**
 * The top of a pane tab: what the agent is and what it is doing (a shape and words, never colour alone), its machine
 * and folder, `Stop` while it works, `Show chat` (an agent whose log can be read as a conversation; the chat's own
 * `Show terminal` comes back), find, `Browse files` (its folder on its machine), and `Pane options`: links, duplicate,
 * and the two copies. The words `Read-only view` say what the screen below is: a picture of the pane, not a terminal.
 */
export function PaneHeader(props: {
  info: PaneMeta;
  /** Set for an agent that can be read as a chat (`canShowChat`): adds `Show chat`. */
  onShowChat?: () => void;
  pane: string;
  onStop: () => void;
  onFind: () => void;
  onLinks: () => void;
  onBrowse: () => void;
  onDuplicate: () => void;
  onCopyTitle: () => void;
  onCopyPaneId: () => void;
}) {
  const options = (): MenuEntry[] => [
    { label: "Find in the pane…", shortcut: keyLabel("search"), onSelect: props.onFind },
    { label: "Links in this pane…", onSelect: props.onLinks },
    "separator",
    { label: "Duplicate", onSelect: props.onDuplicate },
    { label: "Copy title", onSelect: props.onCopyTitle },
    { label: `Copy pane id ${props.pane}`, onSelect: props.onCopyPaneId },
  ];
  const where = () =>
    [props.info.agent && agentTitle(props.info.agent), props.info.machineName, props.info.cwd]
      .filter(Boolean)
      .join(" · ");
  return (
    <View class="min-h-14 flex-row items-center gap-3 border-b border-border bg-card px-6 py-2">
      <StatusGlyph status={props.info.status} />
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-2">
          <Text role="header" class="shrink text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>
            {props.info.name}
          </Text>
          <Text class="text-xs text-muted-foreground">{statusText(props.info.status)}</Text>
          <Text class="text-xs text-muted-foreground">Read-only view</Text>
        </View>
        <Clipped class="text-xs text-muted-foreground" label={where()}>
          {where()}
        </Clipped>
      </View>
      <If when={props.info.status === "working"}>
        <Btn small variant="danger" label="Stop" name="Stop the agent" onPress={props.onStop} />
      </If>
      <If when={props.onShowChat}>
        <Btn small variant="ghost" label="Show chat" onPress={() => props.onShowChat?.()} />
      </If>
      <IconButton icon="folder" label="Browse files" onPress={props.onBrowse} />
      <IconButton icon="search" label="Find in the pane" shortcut={keyLabel("search")} onPress={props.onFind} />
      <ActionMenu label="Pane options" entries={options()} />
    </View>
  );
}
