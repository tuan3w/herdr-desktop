import { Text, View } from "nsh";

import type { PaneMeta } from "herdr-desktop/native";

import { StatusGlyph } from "#components/status-glyph";
import { ActionMenu, Btn, Clipped, IconButton, type MenuEntry } from "#kit";
import { agentTitle } from "#lib/agent-kinds";
import { keyLabel } from "#lib/shortcuts";

/**
 * The top of a terminal tab: what the agent is (a shape, its name), its machine and folder, `Chat` (an agent whose log can
 * be read as a conversation: the way back to supervising it), `Browse files` (its folder on its machine) and `Pane
 * options` (duplicate, the two copies). No `Stop`, no `Send`: the person types to the program, and Ctrl+C is theirs.
 */
export function TerminalHeader(props: {
  info: PaneMeta;
  pane: string;
  /** Set for an agent that can be read as a chat (`canShowChat`): adds `Chat`. */
  onShowChat?: () => void;
  onBrowse: () => void;
  onDuplicate: () => void;
  onCopyTitle: () => void;
  onCopyPaneId: () => void;
}) {
  const options = (): MenuEntry[] => [
    { label: "Duplicate", onSelect: props.onDuplicate },
    { label: "Copy title", onSelect: props.onCopyTitle },
    { label: `Copy pane id ${props.pane}`, onSelect: props.onCopyPaneId },
  ];
  const where = () =>
    [props.info.agent && agentTitle(props.info.agent), props.info.machineName, props.info.cwd]
      .filter(Boolean)
      .join(" · ");
  return (
    <View class="min-h-12 flex-row items-center gap-3 border-b border-border bg-card px-6 py-2">
      <StatusGlyph status={props.info.status} />
      <View class="min-w-0 flex-1 gap-1">
        <Text role="header" class="shrink text-sm font-medium text-foreground" style={{ numberOfLines: 1 }}>
          {props.info.name}
        </Text>
        <Clipped class="text-xs text-muted-foreground" label={where()}>
          {where()}
        </Clipped>
      </View>
      <If when={props.onShowChat}>
        <Btn
          small
          variant="outline"
          icon="message"
          label="Chat"
          name="Show chat"
          hint={keyLabel("terminalView")}
          onPress={() => props.onShowChat?.()}
        />
      </If>
      <IconButton icon="folder" label="Browse files" onPress={props.onBrowse} />
      <ActionMenu label="Pane options" entries={options()} />
    </View>
  );
}
