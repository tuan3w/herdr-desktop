import { Text } from "nsh";

import type { PaneMeta } from "herdr-desktop/native";

import { TopBar } from "#components/top-bar";
import { ActionMenu, Btn, Clipped, IconButton, type MenuEntry } from "#kit";
import { agentTitle } from "#lib/agent-kinds";
import { headerOnBand } from "#lib/chrome";
import { keyLabel } from "#lib/shortcuts";
import { namedPlace, terminalTitle } from "#lib/tabs";

/**
 * The top of a terminal tab, one `TopBar` line like a chat's: its name (only while no tab strip says it), its agent, machine
 * and folder, `Chat` (an agent whose log can be read as a conversation: the way back to supervising it), `Browse files`
 * (its folder on its machine) and `Pane options` (duplicate, the two copies). No state mark: the sidebar row says it once.
 * No `Stop`, no `Send`: the person types to the program, and Ctrl+C is theirs.
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
    [
      props.info.agent && agentTitle(props.info.agent),
      ...namedPlace(props.info),
      props.info.machineName,
      props.info.cwd,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <TopBar>
      <If when={headerOnBand()}>
        <Text role="header" class="shrink px-1 text-sm font-medium text-foreground" style={{ numberOfLines: 1 }}>
          {terminalTitle(props.info)}
        </Text>
      </If>
      <Clipped
        fade={["from-background/0 to-background"]}
        boxClass={`min-w-0 flex-1 ${headerOnBand() ? "" : "pl-1"}`}
        class="text-xs text-muted-foreground"
        label={where()}
      >
        {where()}
      </Clipped>
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
    </TopBar>
  );
}
