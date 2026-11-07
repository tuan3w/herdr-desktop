import "./fonts/Inter-Regular.ttf";
import "./fonts/Inter-Medium.ttf";
import "./fonts/Inter-SemiBold.ttf";
import "./fonts/Inter-Bold.ttf";
import "./fonts/IBMPlexMono-Regular.ttf";
import "./fonts/IBMPlexMono-Medium.ttf";

import { Herdr } from "herdr-desktop/native";
import { announce, effect, host, keymap, lifecycle, mount, View, windowSize } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";
import { isAvailable, Menu, Window } from "nsh/desktop";

import { BulkBar } from "#components/bulk-bar";
import { DevPanel } from "#components/dev-panel";
import { Files } from "#components/files";
import { Machines } from "#components/machines";
import { NameDialog } from "#components/name-dialog";
import { NewSession } from "#components/new-session";
import { Palette } from "#components/palette";
import { SendFiles } from "#components/send-files";
import { Settings } from "#components/settings";
import { Shortcuts } from "#components/shortcuts";
import { Sidebar } from "#components/sidebar";
import { StartAgent } from "#components/start-agent";
import { StatusBar } from "#components/status-bar";
import { WebPage } from "#components/web-page";
import { Workspace } from "#components/workspace";
import { notify, PopupRoot, rail, Skeleton, snug, ThemeRoot, ToastHost } from "#kit";
import {
  actions,
  appMenu,
  globalActions,
  machinesOpen,
  naming,
  newAgentOpen,
  newSessionOpen,
  newSessionProject,
  palette,
  runAction,
  settingsOpen,
  shortcutsOpen,
} from "#lib/actions";
import { dockReady, loadDock, openPane, openSession, showBoard } from "#lib/dock";
import { board, startHerdr } from "#lib/herdr";
import { warmCode } from "#lib/highlight";
import { RAIL_WIDTH, SIDEBAR_WIDTH } from "#lib/layout";
import { hoverTransition, motionReady } from "#lib/motion";
import { openTarget } from "#lib/open-agent";
import { saveFailures } from "#lib/save";
import { loadSettings, settingsReady } from "#lib/settings";
import { type GlobalShortcut, GLOBAL, keysOf } from "#lib/shortcuts";
import { loadSidebar, sidebarReady, sidebarWidth } from "#lib/sidebar";

// A test opens the app with `host: { params: { fixture } }`: the engine then runs against the scripted herdr (the Rust
// side honours it only with HERDR_DESKTOP_TEST=1). In the real app `host.params` is empty.
const fixture = typeof host.params.fixture === "string" ? host.params.fixture : undefined;
// A scripted run keeps its files in a fresh temporary directory (the empty path), never in the person's data directory.
startHerdr(fixture ? "" : (process.dataDir ?? ""), fixture);
void loadSettings();
warmCode();
void loadDock();
void loadSidebar();
for (const warning of Herdr.warnings()) notify(warning, { lasting: true });

// A click on a desktop notification brings the window forward and shows what it was about: that agent's tab, or the
// board for a summary. (The window manager may refuse to raise a window; the tab opens anyway.)
Herdr.onNotificationOpen(({ machine, pane }) => {
  if (isAvailable) Window.orderFront();
  if (machine && pane) void openTarget(machine, pane);
  else void showBoard();
});

/** First frame while the saved layout loads: the shape of the window, so nothing jumps when it arrives. */
function LoadingScreen() {
  return (
    <View accessibilityLabel="Loading" accessibilityState={{ busy: true }} class="flex-1 gap-4 p-6">
      <Skeleton class="h-8 w-48" />
      <Skeleton class="h-24 w-full" />
      <Skeleton class="h-24 w-full" />
    </View>
  );
}

function App() {
  // One handler per entry of `GLOBAL` (`lib/actions.ts`): a shortcut added there without one does not compile.
  // The keys of this platform: `mod` is Command or Ctrl, and a shortcut may have extra keys where its habit differs (F1).
  const bindings = (always: boolean) =>
    Object.fromEntries(
      Object.entries(GLOBAL)
        .filter(([, shortcut]) => (shortcut.always ?? false) === always)
        .flatMap(([id, shortcut]) => keysOf(shortcut).map((keys) => [keys, globalActions[id as GlobalShortcut]])),
    );
  keymap.bind(bindings(false));
  keymap.bind(bindings(true), { when: "always" });

  // The title is the one count the person sees from another window: how many agents need them.
  if (isAvailable) {
    // nsh opens a window phone-sized (390 x 844) and the sidebar alone takes a third of that: open at desktop size. A window
    // that is already wider (a test or a screenshot that sized it) is left alone.
    if (windowSize().width < 600) Window.setFrame({ size: { width: 1280, height: 800 } });
    effect(() => Window.setTitle(board().title));
    effect(() => Menu.setApplicationMenu(appMenu()));
  }
  // A window in the background lets the machines space out their polls and retries.
  effect(() => Herdr.setBackground(lifecycle() !== "active"));

  let loading = false;
  const ready = () => dockReady() && settingsReady() && sidebarReady();
  // In a snug window (under 1100) the full sidebar is its narrow width and its edge is fixed; the person's own width is kept for wide windows.
  const fixedWidth = () => rail() || snug();
  const sideWidth = () => (rail() ? RAIL_WIDTH : snug() ? SIDEBAR_WIDTH.narrow : sidebarWidth());
  effect(() => {
    if (!ready()) {
      loading = true;
    } else if (loading) {
      loading = false;
      announce("Loaded");
      // What is on screen now does not move; what arrives from here on does.
      setTimeout(() => motionReady.set(true), 600);
    }
  });
  // A full storage must never be silent: the newest changes are then only in memory. One warning per 30 s.
  let warnedAt = 0;
  effect(() => {
    if (saveFailures() === 0) return;
    const now = Date.now();
    if (now - warnedAt < 30000) return;
    warnedAt = now;
    notify("Could not save the latest changes: the storage of Herdr Desktop is full.", { lasting: true });
  });

  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <ResizablePanelGroup
          disabled={fixedWidth()}
          handleClass={`bg-sidebar-border ${fixedWidth() ? "" : "group-hover:w-[3px] group-hover:bg-sidebar-ring group-active:w-[3px] group-active:bg-sidebar-ring"}`}
          handleStyle={hoverTransition()}
          handleAccessibilityLabel="Resize the sidebar"
        >
          <ResizablePanel
            fixed
            size={sideWidth()}
            minSize={fixedWidth() ? sideWidth() : SIDEBAR_WIDTH.min}
            maxSize={fixedWidth() ? sideWidth() : SIDEBAR_WIDTH.max}
            onResize={({ size }) => {
              if (!fixedWidth()) sidebarWidth.set(Math.round(size));
            }}
          >
            <Sidebar />
          </ResizablePanel>
          <ResizablePanel class="min-w-0">
            <If when={ready()} else={<LoadingScreen />}>
              <View class="size-full">
                <Workspace />
                <BulkBar />
                <StatusBar />
              </View>
            </If>
          </ResizablePanel>
        </ResizablePanelGroup>
        <Palette open={palette()} onClose={() => palette.set(false)} items={actions()} onRun={runAction} />
        <Shortcuts open={shortcutsOpen()} onClose={() => shortcutsOpen.set(false)} />
        <Settings open={settingsOpen()} onClose={() => settingsOpen.set(false)} />
        <Machines open={machinesOpen()} onClose={() => machinesOpen.set(false)} />
        <Files />
        <WebPage />
        <SendFiles />
        <StartAgent
          open={newAgentOpen()}
          onClose={() => newAgentOpen.set(false)}
          onStarted={(machine, pane) => void openPane(machine, pane)}
        />
        <NewSession
          open={newSessionOpen()}
          onClose={() => newSessionOpen.set(false)}
          onStarted={(machine, id) => void openSession(machine, id)}
          project={newSessionProject()}
        />
        <NameDialog
          open={naming() !== null}
          title={naming()?.title ?? ""}
          initial={naming()?.initial}
          confirm={naming()?.confirm ?? ""}
          onClose={() => naming.set(null)}
          onSubmit={(name) => naming()?.onSubmit(name)}
        />
        <ToastHost />
        <DevPanel />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(App);
