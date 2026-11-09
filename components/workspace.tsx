import { cleanup, effect, untracked, View } from "nsh";
import { DockArea } from "nsh/base";

import { Board } from "#components/board";
import { Changes } from "#components/changes";
import { FilesTab } from "#components/files";
import { NotRunning } from "#components/not-running";
import { ProjectEmpty } from "#components/project-empty";
import { SessionTab } from "#components/session-tab";
import { dockWidth, TabFace, tabFrameClass, tabsCompact } from "#components/tab-face";
import { TerminalTab } from "#components/terminal-tab";
import { Btn, EDGE, Empty } from "#kit";
import { openSettings } from "#lib/actions";
import { mainInset } from "#lib/chrome";
import {
  attach,
  activated,
  BOARD,
  entered,
  focused,
  layout,
  openTerminal,
  parseChangesKey,
  parseFilesKey,
  parseTerminalKey,
  parseSessionKey,
  removePanel,
  setLayout,
  stripsShown,
} from "#lib/dock";
import { meta } from "#lib/herdr";
import { contextEnter, hoverTransition } from "#lib/motion";
import { openAgent } from "#lib/open-agent";

/**
 * The tab area: splits of tab groups the person arranges. The board is the home tab (never closable); each opened agent
 * is a chat tab (`session:<machine>/<id>`: a keeper session, or the chat read from a terminal agent's log) or a terminal
 * tab (`terminal:<machine>/<paneId>`, the herdr client in a pty). A tab is a view: closing it leaves the pane or the session running. Dragging a tab
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
  // The chat of an agent in a herdr pane reads that pane; one herdr could not restore has nothing to read.
  const pane = at.id.startsWith("pane:") ? meta(at.machine, at.id.slice("pane:".length)) : undefined;
  return (
    <If
      when={pane?.()?.feedState === "unrestored"}
      else={<SessionTab machine={at.machine} id={at.id} active={focused() === props.id} />}
    >
      {() => <NotRunning reason={pane?.()?.restoreError ?? undefined} />}
    </If>
  );
}

/** A checkout's Changes tab: what its agents changed since the last commit, to review. */
function ChangesPanel(props: { id: string }) {
  const at = parseChangesKey(props.id);
  if (!at) return <AgentGone panel={props.id} />;
  return <Changes machine={at.machine} cwd={at.cwd} active={focused() === props.id} />;
}

/** A Files tab: one folder of a machine as a table, beside the chat. */
function FilesPanel(props: { id: string }) {
  if (!parseFilesKey(props.id)) return <AgentGone panel={props.id} />;
  return <FilesTab id={props.id} active={focused() === props.id} />;
}

function TerminalPanel(props: { id: string }) {
  const at = parseTerminalKey(props.id);
  if (!at) return <AgentGone panel={props.id} />;
  const info = meta(at.machine, at.pane);
  // A machine the list no longer has reads `null`, a pane herdr dropped reads `gone`: both leave only a tab to close.
  return (
    <If when={info() !== null && info()!.feedState !== "gone"} else={<AgentGone panel={props.id} />}>
      <TerminalTab
        machine={at.machine}
        pane={at.pane}
        active={focused() === props.id}
        onOpenPane={(machine, pane) => void openTerminal(machine, pane)}
      />
    </If>
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
    <View
      style={enter.style}
      class="min-h-0 min-w-0 flex-1"
      onLayout={({ bounds }) => dockWidth.set(bounds.size.width)}
    >
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
              onAddMachine={() => openSettings("machines")}
            />
          ) : id.startsWith("session:") ? (
            <SessionPanel id={id} />
          ) : id.startsWith("changes:") ? (
            <ChangesPanel id={id} />
          ) : id.startsWith("files:") ? (
            <FilesPanel id={id} />
          ) : (
            <TerminalPanel id={id} />
          )
        }
        renderEmpty={() => <ProjectEmpty />}
        renderTab={(tab) => <TabFace tab={tab} />}
        renderDragPreview={(tab) => (
          <View class={`h-8 w-56 rounded-md bg-popover ${EDGE.md}`}>
            <TabFace tab={{ ...tab, closable: false }} />
          </View>
        )}
        renderDropIndicator={() => <View class="size-full" />}
        groupClass="bg-background"
        tabBarClass={stripsShown(layout()) ? "flex-row flex-wrap gap-1 bg-background p-1" : "hidden"}
        tabBarStyle={{ paddingLeft: 4 + mainInset().left, paddingRight: 4 + mainInset().right }}
        tabClass={tabFrameClass(tabsCompact())}
        tabStyle={hoverTransition()}
        contentClass="min-h-0 flex-1"
        dropIndicatorClass="rounded-md border-2 border-primary bg-primary/10"
        handleClass="bg-border group-hover:bg-ring group-active:bg-ring"
        handleAccessibilityLabel="Resize the tab groups"
      />
    </View>
  );
}
