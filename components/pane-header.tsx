import { Text, View } from "nsh";
import type { PaneMeta } from "herdr-desktop/native";
import { paneFit, type PaneFit } from "../lib/settings";
import { keyLabel } from "../lib/shortcuts";
import { statusText } from "../lib/status";
import { agentTitle } from "./composer";
import { ActionMenu, Btn, Clipped, IconButton, type MenuEntry } from "./kit";
import { StatusGlyph } from "./status-glyph";

/**
 * The top of a pane tab: what the agent is and what it is doing (a shape and words, never colour alone), its machine
 * and folder, `Stop` while it works, find, and `Pane options`: the layout of the mirror (kept in Settings: the choice
 * is the person's, not this pane's), links, duplicate, and the two copies.
 */
export function PaneHeader(props: {
  info: PaneMeta;
  pane: string;
  onStop: () => void;
  onFind: () => void;
  onLinks: () => void;
  onDuplicate: () => void;
  onCopyTitle: () => void;
  onCopyPaneId: () => void;
}) {
  const options = (): MenuEntry[] => [
    {
      type: "radio",
      label: "Layout",
      value: paneFit(),
      onValueChange: (value) => paneFit.set(value as PaneFit),
      items: [
        { value: "width", label: "Fit width" },
        { value: "actual", label: "Actual size" },
        { value: "wrap", label: "Wrap lines" },
      ],
      closeOnClick: true,
    },
    "separator",
    { label: "Find in the pane…", shortcut: keyLabel("search"), onSelect: props.onFind },
    { label: "Links in this pane…", onSelect: props.onLinks },
    "separator",
    { label: "Duplicate", onSelect: props.onDuplicate },
    { label: "Copy title", onSelect: props.onCopyTitle },
    { label: `Copy pane id ${props.pane}`, onSelect: props.onCopyPaneId },
  ];
  const where = () => [props.info.agent && agentTitle(props.info.agent), props.info.machineName, props.info.cwd].filter(Boolean).join(" · ");
  return (
    <View class="flex-row items-center gap-3 border-b border-border bg-card px-3 py-2">
      <StatusGlyph status={props.info.status} size={16} />
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-2">
          <Text role="header" class="shrink text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>
            {props.info.name}
          </Text>
          <Text class="text-xs text-muted-foreground">{statusText(props.info.status)}</Text>
        </View>
        <Clipped class="text-xs text-muted-foreground" label={where()}>
          {where()}
        </Clipped>
      </View>
      <If when={props.info.status === "working"}>
        <Btn small variant="danger" label="Stop" name="Stop the agent" onPress={props.onStop} />
      </If>
      <IconButton icon="search" label="Find in the pane" shortcut={keyLabel("search")} onPress={props.onFind} />
      <ActionMenu label="Pane options" entries={options()} />
    </View>
  );
}
