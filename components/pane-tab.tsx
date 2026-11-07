import { announce, Clipboard, effect, signal, Text, View } from "nsh";
import { Herdr, PaneScreen } from "herdr-desktop/native";
import type { PaneLink, PaneScreenRef } from "herdr-desktop/native";
import { meta } from "../lib/herdr";
import { type PaneInput, registerPane } from "../lib/pane-input";
import { announceOutput, minContrast, paneFit, paneFontSize } from "../lib/settings";
import { keyLabel } from "../lib/shortcuts";
import { AnswerDock } from "./answer-dock";
import { CaptureBar } from "./capture-bar";
import { Composer, type ComposerHandle } from "./composer";
import { Btn, dialogDepth, Empty, notify } from "./kit";
import { KeyRow } from "./key-row";
import { LinksDialog, openLink } from "./links-dialog";
import { PaneFind } from "./pane-find";
import { PaneHeader } from "./pane-header";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One agent's pane as a tab: header, the read-only mirror of its screen, the answer dock while it asks something, the
 * message box and the key row. It is a mirror: herdr gives the app the pane's rows and takes text and keys back, there is
 * no cursor or mouse, so typing goes through the message box or capture mode (`mod+shift+k`, `CaptureBar`).
 *
 * While `active` the tab is the pane the global functions of `lib/pane-input.ts` act on (capture, links, find, the
 * message box). `onOpenPane` is how `Duplicate` shows the new tab it made; a host that omits it gets a toast instead.
 *
 * Links in the mirror: a web address opens in the browser; a file path is copied (`openLink`), because the viewer for
 * files is not built and a path on another machine is not one this computer can open.
 */
export function PaneTab(props: { machine: string; pane: string; active: boolean; onOpenPane?: (machine: string, pane: string) => void }) {
  const info = meta(props.machine, props.pane);
  const capturing = signal(false);
  const finding = signal(false);
  const links = signal<PaneLink[] | null>(null);
  let screen: PaneScreenRef | undefined;
  let composer: ComposerHandle | undefined;

  // A pane herdr no longer has (or a machine that is not listed) has nothing to show.
  const shown = () => {
    const i = info();
    return i && i.feedState !== "gone" ? i : null;
  };
  const name = () => info()?.name ?? props.pane;
  const live = () => info()?.feedState === "live";
  const prompt = () => info()?.prompt ?? null;

  // The mirror shows what herdr last said; after something was sent, read again instead of waiting for its next event.
  const refresh = () => void Herdr.readPane(props.machine, props.pane, "visible").catch(() => undefined);
  const failed = (what: string) => (e: unknown) => notify(`${what}: ${reason(e)}`, { type: "error" });
  const sendKeys = (keys: string[]) => void Herdr.sendKeys(props.machine, props.pane, keys).then(refresh, failed("Could not send the key"));

  const leaveCapture = () => {
    if (!capturing()) return;
    capturing.set(false);
    announce(`Stopped typing into ${name()}`);
  };
  const toggleCapture = () => {
    if (capturing()) return leaveCapture();
    if (dialogDepth() > 0) return;
    if (!live()) return announce("Cannot type into the pane: its machine is not connected");
    finding.set(false);
    capturing.set(true);
  };
  const showLinks = async () => {
    try {
      links.set((await screen?.links()) ?? []);
    } catch (e) {
      failed("Could not read the links")(e);
    }
  };

  const handle: PaneInput = {
    toggleCapture,
    capturing: () => capturing(),
    showLinks: () => void showLinks(),
    focusComposer: () => composer?.focus(),
    searchInPane: () => {
      if (capturing()) leaveCapture();
      finding.set(true);
    },
  };
  effect(() => {
    if (!props.active) return;
    return registerPane(handle);
  });
  // A tab that is not in front, or whose machine went away, is not typed into.
  effect(() => {
    if (capturing() && (!props.active || !live())) leaveCapture();
  });

  const duplicate = async () => {
    const i = info();
    if (!i?.workspaceId) return notify("Could not find this pane's workspace", { type: "error" });
    const workspaceId = i.workspaceId;
    try {
      // An agent starts again in the same folder; a terminal gets a new tab in its folder.
      const made =
        i.agent && i.cwd
          ? await Herdr.startAgent(props.machine, { cwd: i.cwd, agent: i.agent, name: i.name, workspaceId })
          : await Herdr.createTab(props.machine, workspaceId, i.name, i.cwd);
      if (props.onOpenPane) props.onOpenPane(props.machine, made.paneId);
      else notify(`Opened a copy of ${i.name}`);
    } catch (e) {
      failed("Could not duplicate")(e);
    }
  };
  const copy = (text: string, done: string) => void Clipboard.writeText(text).then(() => notify(done));

  return (
    <View class="min-h-0 flex-1 bg-background">
      <If when={shown()} else={<Empty fill icon="alert" title="This agent is gone" hint="herdr no longer has this pane. Close the tab." />}>
        {(i) => (
          <>
            <PaneHeader
              info={i()}
              pane={props.pane}
              onStop={() => {
                sendKeys(["esc"]);
                announce(`Sent Escape to ${name()}`);
              }}
              onFind={() => handle.searchInPane()}
              onLinks={() => handle.showLinks()}
              onDuplicate={() => void duplicate()}
              onCopyTitle={() => copy(i().name, "Title copied")}
              onCopyPaneId={() => copy(props.pane, "Pane id copied")}
            />
            <If when={i().feedState === "stale"}>
              <View role="alert" class="border-b border-border bg-muted px-3 py-1.5">
                <Text class="text-xs text-foreground">{`${i().machineName} is not connected. This is the last text it showed; typing is off until it reconnects.`}</Text>
              </View>
            </If>
            <If when={finding()}>
              <PaneFind
                rows={() => screen?.rows() ?? Promise.resolve([])}
                scrollToRow={(row) => screen?.scrollToRow(row)}
                onClose={() => {
                  finding.set(false);
                  composer?.focus();
                }}
              />
            </If>
            <PaneScreen
              ref={(ref: PaneScreenRef) => {
                screen = ref;
              }}
              class="min-h-0 flex-1"
              machine={props.machine}
              pane={props.pane}
              label={`Terminal, ${i().name} on ${i().machineName}`}
              fit={paneFit()}
              fontSize={paneFontSize()}
              minContrast={minContrast()}
              announceOutput={announceOutput()}
              onLink={(e) => void openLink(e.kind, e.target, e.line, e.col)}
            />
            <If
              when={capturing()}
              else={
                <View class="flex-row items-center gap-2 px-3 py-1">
                  <Text class="min-w-0 flex-1 text-xs text-muted-foreground">Mirror: type with Mirror mode or the composer</Text>
                  <Btn small label="Mirror mode" name="Mirror mode, type into the pane" hint={keyLabel("capture")} disabled={!live()} onPress={toggleCapture} />
                </View>
              }
            >
              <CaptureBar machine={props.machine} pane={props.pane} name={i().name} onLeave={leaveCapture} />
            </If>
            <If when={prompt()}>
              {(p) => <AnswerDock machine={props.machine} pane={props.pane} prompt={p()} onSent={refresh} />}
            </If>
            <Composer
              machine={props.machine}
              pane={props.pane}
              agent={i().agent}
              name={i().name}
              blocked={prompt() !== null}
              disabled={!live()}
              onHandle={(h) => {
                composer = h;
              }}
              onSent={refresh}
            />
            <KeyRow agent={i().agent !== ""} disabled={!live()} onKeys={sendKeys} onInsert={(text) => composer?.insert(text)} />
            <LinksDialog open={links() !== null} links={links() ?? []} onClose={() => links.set(null)} />
          </>
        )}
      </If>
    </View>
  );
}
