import { cleanup, View } from "nsh";
import { DockArea, type DockTab } from "nsh/base";
import { machinesOpen } from "../lib/actions";
import { attach, activated, BOARD, closeTab, focused, layout, openPane, parsePaneKey, removePanel, setLayout } from "../lib/dock";
import { meta } from "../lib/herdr";
import { hoverTransition } from "../lib/motion";
import { keyLabel } from "../lib/shortcuts";
import { Board } from "./board";
import { Btn, Clipped, Empty, FOCUS_RING_INSET, Icon, IconButton } from "./kit";
import { PaneTab } from "./pane-tab";
import { StatusGlyph } from "./status-glyph";

/**
 * The tab area: splits of tab groups the person arranges. The board is the home tab (never closable); each opened agent
 * or terminal is a `pane:<machine>/<paneId>` tab. A tab is a view: closing it leaves the pane running. Dragging a tab
 * is for the pointer; every drag has a keyboard command (`Move tab to split right`, `Move tab to other group`, ...) in
 * the palette, and `mod+\` and `mod+shift+\` split. The layout is `lib/dock.ts`'s and is saved there.
 */

/** What a pane tab shows once herdr no longer has its pane (closed in herdr, or a saved tab for a pane that is gone). */
function AgentGone(props: { panel: string }) {
  return (
    <Empty fill title="Agent gone" hint="herdr no longer has this pane. Closing the tab only removes this view.">
      <Btn label="Close" name="Close this tab" variant="outline" onPress={() => removePanel(props.panel)} />
    </Empty>
  );
}

function PanePanel(props: { id: string }) {
  const at = parsePaneKey(props.id);
  if (!at) return <AgentGone panel={props.id} />;
  const info = meta(at.machine, at.pane);
  // A machine the list no longer has reads `null`, a pane herdr dropped reads `gone`: both leave only a tab to close.
  return (
    <If when={info() !== null && info()!.feedState !== "gone"} else={<AgentGone panel={props.id} />}>
      <PaneTab machine={at.machine} pane={at.pane} active={focused() === props.id} onOpenPane={(machine, pane) => void openPane(machine, pane)} />
    </If>
  );
}

/** A tab's face: the shape of the agent's state, its name, and the cross that closes the view. */
function TabFace(props: { tab: DockTab }) {
  const at = parsePaneKey(props.tab.panel);
  const info = at ? meta(at.machine, at.pane) : () => null;
  const gone = () => at !== null && (info() === null || info()!.feedState === "gone");
  const name = () => (props.tab.panel === BOARD ? "Board" : gone() ? "Agent gone" : (info()?.name ?? at?.pane ?? ""));
  return (
    <View class="max-w-56 flex-row items-center gap-2">
      <If when={props.tab.panel === BOARD} else={<StatusGlyph status={gone() ? "unknown" : (info()?.status ?? "unknown")} size={12} />}>
        <Icon name="list" size={14} tone="muted-foreground" />
      </If>
      <Clipped class={`text-sm ${props.tab.active ? "text-foreground" : "text-muted-foreground"}`}>{name()}</Clipped>
      <If when={props.tab.closable}>
        {/* Closing is mod+w and the palette for the keyboard and screen readers: a button inside a tab would be a control within a control. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <IconButton icon="x" label={`Close tab ${name()}`} shortcut={keyLabel("closeTab")} onPress={() => closeTab(props.tab.panel)} />
        </View>
      </If>
    </View>
  );
}

export function Workspace() {
  cleanup(() => attach(undefined));
  return (
    <DockArea
      ref={(ref) => attach(ref)}
      class="min-h-0 min-w-0 flex-1 bg-background"
      layout={layout()}
      onLayoutChange={({ layout: next }) => setLayout(next)}
      onPanelActiveChange={({ panel, active }) => {
        if (active) activated(panel);
      }}
      panels={[{ id: BOARD, closable: false }]}
      renderPanel={({ id }) => (id === BOARD ? <Board onOpenPane={(machine, pane, options) => void openPane(machine, pane, options)} onAddMachine={() => machinesOpen.set(true)} /> : <PanePanel id={id} />)}
      renderTab={(tab) => <TabFace tab={tab} />}
      renderDragPreview={(tab) => (
        <View class="rounded-md border border-border bg-popover px-3 py-1.5 shadow-md">
          <TabFace tab={{ ...tab, closable: false }} />
        </View>
      )}
      renderDropIndicator={() => <View class="size-full" />}
      groupClass="bg-background"
      tabBarClass="flex-row border-b border-border bg-sidebar"
      tabClass={`h-9 flex-row items-center border-r border-border px-3 selected:bg-background ${FOCUS_RING_INSET}`}
      tabStyle={hoverTransition()}
      contentClass="min-h-0 flex-1"
      dropIndicatorClass="rounded-md border-2 border-primary bg-primary/10"
      handleClass="bg-border group-hover:bg-ring group-active:bg-ring"
      handleAccessibilityLabel="Resize the tab groups"
    />
  );
}
