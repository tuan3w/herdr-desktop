import { Files, Herdr, Terminal } from "herdr-desktop/native";
import { announce, Clipboard, effect, keymap, signal, Text, View } from "nsh";

import type { TerminalRef } from "herdr-desktop/native";

import { LinkPanelView } from "#components/link-panel";
import { openLink } from "#components/open-link";
import { TerminalHeader } from "#components/terminal-header";
import { TerminalOff } from "#components/terminal-off";
import { Btn, Empty, notify } from "#kit";
import { arm, isArmed, takePointing, terminalKey } from "#lib/dock";
import { sending } from "#lib/files";
import { meta } from "#lib/herdr";
import { createLinkPanel } from "#lib/link-panel";
import { canShowChat, showChat } from "#lib/open-agent";
import { browseFiles } from "#lib/open-files";
import { registerPane } from "#lib/pane-input";
import { minContrast, terminalEnabled, terminalFontSize, terminalOptionAsMeta } from "#lib/settings";
import { paletteFromTerminalKey } from "#lib/shortcuts";
import { herdrClientCommand } from "#lib/terminal-command";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What the tab runs for a pane: the official `herdr` client for the pane's machine (`lib/terminal-command.ts`), or, in a
 * test run (`HERDR_DESKTOP_TEST=1`), the synthetic program `Herdr.testSetProgram` set: a test never starts a real herdr.
 */
function programOf(machine: string): { command: string } | { why: string } {
  const test = Herdr.testProgram();
  if (test) return { command: test };
  const at = Herdr.machines().find((m) => m.id === machine);
  if (!at) return { why: "herdr does not know this machine any more" };
  return herdrClientCommand({ local: at.local, dest: at.dest, port: at.port, session: at.session });
}

interface TerminalTabProps {
  machine: string;
  pane: string;
  active: boolean;
  onOpenPane?: (machine: string, pane: string) => void;
}

/**
 * The tab of a pane's terminal. While the terminal tab is off in Settings (`terminalEnabled`, the default for now) it mounts
 * no native `Terminal` and none of its effects (no pointing herdr at the pane, no zoom, no keys): `TerminalOff` says how to
 * open the agent in the person's own terminal. Turned on, a tab mounts `LiveTerminal` afresh, which reads `Press Return to
 * reconnect` because nothing armed it while off.
 */
export function TerminalTab(props: TerminalTabProps) {
  return (
    <If when={terminalEnabled()} else={<TerminalOff machine={props.machine} pane={props.pane} />}>
      {() => (
        <LiveTerminal machine={props.machine} pane={props.pane} active={props.active} onOpenPane={props.onOpenPane} />
      )}
    </If>
  );
}

/**
 * An agent's pane as a real terminal: a pty running the herdr client, drawn by `Terminal`, with the whole keyboard and
 * mouse (`docs/specs/terminal.md`). Typing goes to the program and that is the one way to answer: there is no message box and no
 * answer dock here, and the app never sends anything the person did not type.
 *
 * The client opens on the session, not on one pane (it has no such option), so before it attaches the tab points herdr at
 * the pane with the public API (`Herdr.focusPane`: it moves herdr's own focus, which the person asked for by opening this
 * tab) and zooms it (`Herdr.zoomPane`), so the client shows that pane alone; closing the tab puts the zoom back. A tab
 * restored from the saved layout does not attach by itself: it says `Press Return to reconnect`, because a restart must
 * never put a client into a live agent session unasked (`isArmed`).
 *
 * While `active` the tab is the pane `lib/pane-input.ts` acts on (`Reply…` puts the keyboard in the terminal). `onOpenPane`
 * is how `Duplicate` shows the new tab; a host that omits it gets a toast instead. Files dropped on the tab are offered to
 * the machine's folder (`SendFiles`). A link the program prints opens in the tab's side panel (`LinkPanelView`), as a
 * chat's does.
 */
function LiveTerminal(props: TerminalTabProps) {
  const info = meta(props.machine, props.pane);
  const key = terminalKey(props.machine, props.pane);
  let term: TerminalRef | undefined;
  const links = createLinkPanel();
  let zoomed = false;
  // `starting`: herdr is being pointed at the pane; `restored`: waits for the person; `running`: the client is attached.
  const phase = signal<"restored" | "starting" | "running">(isArmed(key) ? "starting" : "restored");

  const shown = () => {
    const i = info();
    return i && i.feedState !== "gone" ? i : null;
  };
  const name = () => info()?.name ?? props.pane;
  const live = () => info()?.feedState === "live";
  const command = () => {
    const p = programOf(props.machine);
    return "command" in p ? p.command : null;
  };
  const failure = () => {
    const p = programOf(props.machine);
    return "why" in p ? p.why : "";
  };

  // The client opens on the session, not on one pane: point herdr at the pane first, once per opening. A failure is said and
  // the client attaches anyway, to whatever herdr shows.
  const start = async () => {
    phase.set("starting");
    if (takePointing(key)) {
      await Herdr.focusPane(props.machine, props.pane).catch((e: unknown) =>
        notify(`Could not point herdr at this pane: ${reason(e)}`, { type: "error" }),
      );
    }
    // Zoomed, the client shows this pane alone, not herdr's sidebar of every agent and the panes beside it. Only a zoom this tab
    // made is undone when it closes: a pane the person had zoomed stays as they left it.
    zoomed = await Herdr.zoomPane(props.machine, props.pane, true).catch(() => false);
    phase.set("running");
  };
  if (phase() === "starting") void start();
  effect(() => () => {
    if (zoomed) void Herdr.zoomPane(props.machine, props.pane, false).catch(() => false);
  });
  // `Press Return to reconnect`, or `Reconnect`: the person's own action starts the program.
  const reconnect = () => {
    arm(key);
    void start();
  };
  // Return reconnects while the tab shows that line: nothing else in it takes Return.
  effect(() => {
    if (!props.active || phase() !== "restored") return;
    // Not while a text field is being edited: Return in the palette's or a dialog's field must never attach a client.
    return keymap.bind("enter", reconnect, { when: "notEditing" });
  });

  effect(() => {
    if (!props.active) return;
    const handle = {
      focusComposer: () => term?.focus(),
      // `mod+f` finds in what a file or a chat shows; a program's own search is the program's.
      searchInPane: () => announce("This is a terminal: search with the program's own keys"),
    };
    const stop = registerPane(handle);
    // The one announcement of this tab's rule, on entry: `design/taste.md` rule 7, say it once.
    announce(`Terminal, ${name()}. Keys go to the program. ${paletteFromTerminalKey()} opens the command palette.`);
    return stop;
  });
  effect(() => {
    if (props.active && phase() === "running") queueMicrotask(() => term?.focus());
  });

  const duplicate = async () => {
    const i = info();
    if (!i?.workspaceId) return notify("Could not find this pane's workspace", { type: "error" });
    try {
      // An agent starts again in the same folder; a terminal gets a new tab in its folder.
      const made =
        i.agent && i.cwd
          ? await Herdr.startAgent(props.machine, {
              cwd: i.cwd,
              agent: i.agent,
              name: i.name,
              workspaceId: i.workspaceId,
            })
          : await Herdr.createTab(props.machine, i.workspaceId, i.name, i.cwd);
      if (props.onOpenPane) props.onOpenPane(props.machine, made.paneId);
      else notify(`Opened a copy of ${i.name}`);
    } catch (e) {
      notify(`Could not duplicate: ${reason(e)}`, { type: "error" });
    }
  };
  const copy = (text: string, done: string) => void Clipboard.writeText(text).then(() => notify(done));

  // Files dragged from the file manager: offered to this pane's machine, never sent before the person confirms.
  const dropping = signal(false);
  const dropFiles = (uris: string[]) => {
    const paths = uris.map((uri) => Files.pathFromUri(uri)).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return notify("Only files from this computer can be sent", { type: "error" });
    if (!live()) return notify("Cannot send: the machine is not connected", { type: "error" });
    sending.set({ machine: props.machine, folder: info()?.cwd ?? "~", paths });
  };

  return (
    <View
      class="min-h-0 flex-1 bg-background"
      onFileDragEnter={() => dropping.set(true)}
      onFileDragLeave={() => dropping.set(false)}
      onFileDrop={({ uris }) => {
        dropping.set(false);
        dropFiles(uris);
      }}
    >
      <If
        when={shown()}
        else={
          <Empty fill icon="alert" title="This agent is gone" hint="herdr no longer has this pane. Close the tab." />
        }
      >
        {(i) => (
          <View class="min-h-0 flex-1 flex-row">
            <View class="min-h-0 flex-1">
              <TerminalHeader
                info={i()}
                pane={props.pane}
                onShowChat={
                  canShowChat(props.machine, props.pane) ? () => void showChat(props.machine, props.pane) : undefined
                }
                onBrowse={() => browseFiles(props.machine, i().cwd ?? "~")}
                onDuplicate={() => void duplicate()}
                onCopyTitle={() => copy(i().name, "Title copied")}
                onCopyPaneId={() => copy(props.pane, "Pane id copied")}
              />
              <If when={i().feedState === "stale"}>
                <View role="alert" class="border-b border-border bg-muted px-3 py-2">
                  <Text class="text-xs text-foreground">{`${i().machineName} is not connected. The terminal reconnects with it.`}</Text>
                </View>
              </If>
              <If
                when={phase() !== "restored"}
                else={
                  <Empty
                    fill
                    icon="terminal"
                    title="Press Return to reconnect"
                    hint={`This tab was restored. Reconnecting attaches herdr to ${i().name}.`}
                  >
                    <Btn label="Reconnect" name={`Reconnect to ${i().name}`} onPress={reconnect} />
                  </Empty>
                }
              >
                <If when={phase() === "running"}>
                  <If
                    when={command()}
                    else={<Empty fill icon="alert" title="Could not start the terminal" hint={failure()} />}
                  >
                    {(line) => (
                      <Terminal
                        ref={(ref: TerminalRef) => {
                          term = ref;
                        }}
                        class="min-h-0 flex-1"
                        label={`${i().name} on ${i().machineName}`}
                        command={line()}
                        fontSize={terminalFontSize()}
                        optionAsMeta={terminalOptionAsMeta()}
                        minContrast={minContrast()}
                        onExited={(e) => announce(`${name()}: ${e.words}`)}
                        onLink={(e) =>
                          void openLink(e.kind, e.target, null, null, {
                            machine: props.machine,
                            cwd: i().cwd,
                            panel: links,
                          })
                        }
                      />
                    )}
                  </If>
                </If>
                <Text class="px-6 py-1 text-xs text-muted-foreground">{`Keys go to the program · ${paletteFromTerminalKey()}: palette`}</Text>
              </If>
              <If when={dropping()}>
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  class="absolute inset-0 items-center justify-center border-2 border-dashed border-primary bg-background/80"
                >
                  <Text class="text-sm font-medium text-foreground">{`Drop to send to ${i().machineName}: ${i().cwd ?? "its home folder"}`}</Text>
                </View>
              </If>
            </View>
            {/* Escape belongs to the program in a terminal: the panel closes with its button only. */}
            <LinkPanelView panel={links} cwd={i().cwd ?? ""} active={props.active} escape={false} />
          </View>
        )}
      </If>
    </View>
  );
}
