import { announce, effect, host, keymap, lifecycle, mount, View } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";
import { isAvailable, Menu, Window } from "nsh/desktop";
import { Herdr } from "herdr-desktop/native";
import "./fonts/Inter-Regular.ttf";
import "./fonts/Inter-Medium.ttf";
import "./fonts/Inter-SemiBold.ttf";
import "./fonts/Inter-Bold.ttf";
import "./fonts/IBMPlexMono-Regular.ttf";
import "./fonts/IBMPlexMono-Medium.ttf";
import { BulkBar } from "./components/bulk-bar";
import { DevPanel } from "./components/dev-panel";
import { Machines } from "./components/machines";
import { NameDialog } from "./components/name-dialog";
import { Palette } from "./components/palette";
import { Settings } from "./components/settings";
import { Shortcuts } from "./components/shortcuts";
import { Sidebar } from "./components/sidebar";
import { StartAgent } from "./components/start-agent";
import { Workspace } from "./components/workspace";
import { notify, PopupRoot, RAIL_WIDTH, rail, Skeleton, ThemeRoot, ToastHost } from "./components/kit";
import { actions, appMenu, globalActions, machinesOpen, naming, newAgentOpen, palette, runAction, settingsOpen, shortcutsOpen } from "./lib/actions";
import { dockReady, loadDock, openPane } from "./lib/dock";
import { board, startHerdr } from "./lib/herdr";
import { hoverTransition } from "./lib/motion";
import { saveFailures } from "./lib/save";
import { loadSettings, settingsReady } from "./lib/settings";
import { type GlobalShortcut, GLOBAL, keysOf } from "./lib/shortcuts";
import { loadSidebar, SIDEBAR_WIDTH, sidebarReady, sidebarWidth } from "./lib/sidebar";

// A test opens the app with `host: { params: { fixture } }`: the engine then runs against the scripted herdr (the Rust
// side honours it only with HERDR_DESKTOP_TEST=1). In the real app `host.params` is empty.
const fixture = typeof host.params.fixture === "string" ? host.params.fixture : undefined;
// A scripted run keeps its files in a fresh temporary directory (the empty path), never in the person's data directory.
startHerdr(fixture ? "" : (process.dataDir ?? ""), fixture);
void loadSettings();
void loadDock();
void loadSidebar();
for (const warning of Herdr.warnings()) notify(warning, { lasting: true });

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
  keymap.bind(Object.fromEntries(Object.entries(GLOBAL).flatMap(([id, shortcut]) => keysOf(shortcut).map((keys) => [keys, globalActions[id as GlobalShortcut]]))));

  // The title is the one count the person sees from another window: how many agents need them.
  if (isAvailable) {
    effect(() => Window.setTitle(board().title));
    effect(() => Menu.setApplicationMenu(appMenu()));
  }
  // A window in the background lets the machines space out their polls and retries.
  effect(() => Herdr.setBackground(lifecycle() !== "active"));

  let loading = false;
  const ready = () => dockReady() && settingsReady() && sidebarReady();
  effect(() => {
    if (!ready()) {
      loading = true;
    } else if (loading) {
      loading = false;
      announce("Loaded");
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
          disabled={rail()}
          handleClass={`bg-sidebar-border ${rail() ? "" : "group-hover:w-[3px] group-hover:bg-sidebar-ring group-active:w-[3px] group-active:bg-sidebar-ring"}`}
          handleStyle={hoverTransition()}
          handleAccessibilityLabel="Resize the sidebar"
        >
          <ResizablePanel
            fixed
            size={rail() ? RAIL_WIDTH : sidebarWidth()}
            minSize={rail() ? RAIL_WIDTH : SIDEBAR_WIDTH.min}
            maxSize={rail() ? RAIL_WIDTH : SIDEBAR_WIDTH.max}
            onResize={({ size }) => sidebarWidth.set(Math.round(size))}
          >
            <Sidebar />
          </ResizablePanel>
          <ResizablePanel class="min-w-0">
            <If when={ready()} else={<LoadingScreen />}>
              <View class="size-full">
                <Workspace />
                <BulkBar />
              </View>
            </If>
          </ResizablePanel>
        </ResizablePanelGroup>
        <Palette open={palette()} onClose={() => palette.set(false)} items={actions()} onRun={runAction} />
        <Shortcuts open={shortcutsOpen()} onClose={() => shortcutsOpen.set(false)} />
        <Settings open={settingsOpen()} onClose={() => settingsOpen.set(false)} />
        <Machines open={machinesOpen()} onClose={() => machinesOpen.set(false)} />
        <StartAgent open={newAgentOpen()} onClose={() => newAgentOpen.set(false)} onStarted={(machine, pane) => void openPane(machine, pane)} />
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
