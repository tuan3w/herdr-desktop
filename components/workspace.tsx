import { cleanup, effect, untracked, View } from "nsh";
import { DockArea, type DockTab } from "nsh/base";

import { Board } from "#components/board";
import { PaneTab } from "#components/pane-tab";
import { ProjectEmpty } from "#components/project-empty";
import { SessionTab } from "#components/session-tab";
import { StatusGlyph } from "#components/status-glyph";
import { Btn, Clipped, Empty, FOCUS_RING_INSET, Icon, IconButton } from "#kit";
import { machinesOpen } from "#lib/actions";
import {
  attach,
  activated,
  BOARD,
  closeTab,
  entered,
  focused,
  layout,
  openPane,
  parsePaneKey,
  parseSessionKey,
  removePanel,
  rowKeyOf,
  setLayout,
} from "#lib/dock";
import { meta, rowOf } from "#lib/herdr";
import { ROW } from "#lib/layout";
import { appear, contextEnter, hoverTransition } from "#lib/motion";
import { openAgent } from "#lib/open-agent";
import { keyLabel } from "#lib/shortcuts";

/**
 * The tab area: splits of tab groups the person arranges. The board is the home tab (never closable); each opened agent
 * is a chat tab (`session:<machine>/<id>`: a keeper session, or the chat read from a terminal agent's log) or a terminal
 * tab (`pane:<machine>/<paneId>`). A tab is a view: closing it leaves the pane or the session running. Dragging a tab
 * is for the pointer; every drag has a keyboard command (`Move tab to split right`, `Move tab to other group`, ...) in
 * the palette, and `mod+\` and `mod+shift+\` split. The layouts (one per project, and the home's) are `lib/dock.ts`'s and
 * are saved there; a project with no tab open shows its own card (`ProjectEmpty`). Switching project swaps the layout, and
 * the incoming workspace fades in over a tenth of a second (`contextEnter`): the one motion on a switch.
 */

/** What a pane tab shows once herdr no longer has its pane (closed in herdr, or a saved tab for a pane that is gone). */
function AgentGone(props: { panel: string }) {
  return (
    <Empty fill title="Agent gone" hint="herdr no longer has this pane. Closing the tab only removes this view.">
      <Btn label="Close" name="Close this tab" variant="outline" onPress={() => removePanel(props.panel)} />
    </Empty>
  );
}

/** A chat tab: it attaches (or reads the log) itself and says inline when it cannot, so it is never an `Agent gone` placeholder. */
function SessionPanel(props: { id: string }) {
  const at = parseSessionKey(props.id);
  if (!at) return <AgentGone panel={props.id} />;
  return <SessionTab machine={at.machine} id={at.id} active={focused() === props.id} />;
}

function PanePanel(props: { id: string }) {
  const at = parsePaneKey(props.id);
  if (!at) return <AgentGone panel={props.id} />;
  const info = meta(at.machine, at.pane);
  // A machine the list no longer has reads `null`, a pane herdr dropped reads `gone`: both leave only a tab to close.
  return (
    <If when={info() !== null && info()!.feedState !== "gone"} else={<AgentGone panel={props.id} />}>
      <PaneTab
        machine={at.machine}
        pane={at.pane}
        active={focused() === props.id}
        onOpenPane={(machine, pane) => void openPane(machine, pane)}
      />
    </If>
  );
}

/**
 * A tab's face: the shape of the agent's state, its name, and the cross that closes the view. A terminal tab reads its
 * pane's header facts; a chat tab reads its row of the board (a chat that is not on the board, one that ended, says `Chat`).
 */
function TabFace(props: { tab: DockTab }) {
  const at = parsePaneKey(props.tab.panel);
  const info = at ? meta(at.machine, at.pane) : () => null;
  const chat = parseSessionKey(props.tab.panel) !== null;
  const row = () => {
    const key = chat ? rowKeyOf(props.tab.panel) : null;
    return key === null ? undefined : rowOf(key);
  };
  const gone = () => at !== null && (info() === null || info()!.feedState === "gone");
  const name = () =>
    props.tab.panel === BOARD
      ? "Board"
      : chat
        ? (row()?.name ?? "Chat")
        : gone()
          ? "Agent gone"
          : (info()?.name ?? at?.pane ?? "");
  const status = () => (chat ? (row()?.status ?? "unknown") : gone() ? "unknown" : (info()?.status ?? "unknown"));
  return (
    <View style={appear(props.tab.panel)} class="max-w-56 flex-row items-center gap-2">
      <If when={props.tab.panel === BOARD} else={<StatusGlyph status={status()} size={12} />}>
        <Icon name="list" size={14} tone="muted-foreground" />
      </If>
      <Clipped class={`text-sm ${props.tab.active ? "text-foreground" : "text-muted-foreground"}`}>{name()}</Clipped>
      <If when={props.tab.closable}>
        {/* Closing is mod+w and the palette for the keyboard and screen readers: a button inside a tab would be a control within a control. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <IconButton
            icon="x"
            label={`Close tab ${name()}`}
            shortcut={keyLabel("closeTab")}
            onPress={() => closeTab(props.tab.panel)}
          />
        </View>
      </If>
    </View>
  );
}

export function Workspace() {
  cleanup(() => attach(undefined));
  const enter = contextEnter();
  let first = true;
  effect(() => {
    entered();
    if (first) first = false;
    else untracked(enter.play);
  });
  return (
    <View style={enter.style} class="min-h-0 min-w-0 flex-1">
      <DockArea
        ref={(ref) => attach(ref)}
        class="min-h-0 min-w-0 flex-1 bg-background"
        layout={layout()}
        onLayoutChange={({ layout: next }) => setLayout(next)}
        onPanelActiveChange={({ panel, active }) => {
          if (active) activated(panel);
        }}
        panels={[{ id: BOARD, closable: false }]}
        renderPanel={({ id }) =>
          id === BOARD ? (
            <Board
              onOpen={(row, options) => void openAgent(row, options)}
              onAddMachine={() => machinesOpen.set(true)}
            />
          ) : id.startsWith("session:") ? (
            <SessionPanel id={id} />
          ) : (
            <PanePanel id={id} />
          )
        }
        renderEmpty={() => <ProjectEmpty />}
        renderTab={(tab) => <TabFace tab={tab} />}
        renderDragPreview={(tab) => (
          <View class="rounded-md border border-border bg-popover px-3 py-1.5 shadow-md">
            <TabFace tab={{ ...tab, closable: false }} />
          </View>
        )}
        renderDropIndicator={() => <View class="size-full" />}
        groupClass="bg-background"
        tabBarClass="flex-row border-b border-border bg-sidebar"
        tabClass={`${ROW.tab.class} flex-row items-center border-r border-border selected:bg-background ${FOCUS_RING_INSET}`}
        tabStyle={hoverTransition()}
        contentClass="min-h-0 flex-1"
        dropIndicatorClass="rounded-md border-2 border-primary bg-primary/10"
        handleClass="bg-border group-hover:bg-ring group-active:bg-ring"
        handleAccessibilityLabel="Resize the tab groups"
      />
    </View>
  );
}
