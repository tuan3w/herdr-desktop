import { Herdr, Sessions } from "herdr-desktop/native";
import { announce, cleanup, Clipboard, effect, signal, Text, untracked, View } from "nsh";

import type { SessionInfo, SessionView } from "herdr-desktop/native";

import { PermissionDock } from "#components/permission-dock";
import { SessionActivity } from "#components/session-activity";
import { SessionComposer, type SessionComposerHandle } from "#components/session-composer";
import { SessionHeader } from "#components/session-header";
import { SessionOverview } from "#components/session-overview";
import { SessionPlan } from "#components/session-plan";
import { SessionQuestion } from "#components/session-question";
import { createSignin, SessionSignin } from "#components/session-signin";
import { SessionTranscript } from "#components/session-transcript";
import { Btn, Empty, notify } from "#kit";
import { touched } from "#lib/code-blocks";
import { openSession, removePanel, sessionKey } from "#lib/dock";
import { sending } from "#lib/files";
import { showTerminal } from "#lib/open-agent";
import { registerPane } from "#lib/pane-input";
import { createSessionModel, latest, type SessionPort, sessionPort } from "#lib/session";
import { lastCode, lastReply } from "#lib/session-copy";
import { oneLine, tailText, visibleText } from "#lib/session-text";
import { announceOutput } from "#lib/settings";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Output the person asked to hear is spoken at most this often. */
const SPEAK_EVERY_MS = 2000;

/** What the open of a session is doing: asking the machine, done, or why it could not. */
type Opening = { state: "opening" } | { state: "ready" } | { state: "failed"; message: string };

/**
 * One chat as a tab: an agent session the keeper holds (`id` is the keeper's), or a terminal agent read from its log
 * (`id` is `pane:<paneId>`; `Show terminal` goes back to the pane). The tab attaches or observes itself when it opens and
 * lets go when it closes, so whoever opens it only names it. A session that cannot be opened says why and offers `Try
 * again` (and `Continue` for one whose agent exited and kept its conversation).
 *
 * It is a person's chat first, so it reads like one: a header, the conversation (`SessionTranscript`), the open request
 * (`PermissionDock`, `SessionQuestion`) and the message box (`SessionComposer`). While the agent refuses the session until
 * the person signs in, `SessionSignin` stands in for the conversation and the message box. The keyboard goes to the
 * message box when the tab opens and nowhere else by itself; `mod+2` brings it back. Files dropped on the tab are attached.
 */
export function SessionTab(props: { machine: string; id: string; active: boolean }) {
  return (
    <SessionChat
      machine={props.machine}
      id={props.id}
      active={props.active}
      port={sessionPort(props.machine, props.id)}
    />
  );
}

/**
 * The chat over a `SessionPort`: `SessionTab` gives it the `Sessions` module, a test or a lab its own. The port decides
 * what the data is; opening (`attach` / `observe`) is done by `SessionTab` only when `open` is true.
 */
export function SessionChat(props: {
  machine: string;
  id: string;
  active: boolean;
  port: SessionPort;
  open?: boolean;
}) {
  const opening = signal<Opening>(props.open === false ? { state: "ready" } : { state: "opening" });
  const resumable = signal<SessionInfo | null>(null);
  const continuing = signal(false);
  const reconnecting = signal(false);
  const details = signal(false);
  const dropping = signal(false);
  const atEnd = signal(true);
  const unseen = signal(0);
  /** Why the open failed, or `null` while it has not. */
  const failure = (): string | null => {
    const o = opening();
    return o.state === "failed" ? o.message : null;
  };
  const observedPane = props.id.startsWith("pane:") ? props.id.slice("pane:".length) : null;
  let composer: SessionComposerHandle | undefined;
  let spokeAt = 0;
  let pending = "";

  const model = createSessionModel(props.port, {
    answered: (text) => announce(`Agent: ${oneLine(visibleText(text), 200)}`),
    streamed: (text) => {
      // Streamed text is spoken only when the person asked for it, and never more than once per two seconds.
      if (!announceOutput()) return;
      pending += text;
      const now = Date.now();
      if (now - spokeAt < SPEAK_EVERY_MS) return;
      spokeAt = now;
      announce(tailText(visibleText(pending), 200));
      pending = "";
    },
    arrived: (n) => {
      if (!atEnd()) unseen.update((c) => c + n);
    },
  });
  const signin = createSignin(props.port);
  // Once the agent no longer asks for a sign-in (and is not just reopening), what an earlier attempt said is over.
  effect(() => {
    const phase = model.view()?.phase;
    if (phase && phase !== "authRequired" && phase !== "connecting") untracked(() => signin.reset());
  });

  const open = async () => {
    if (props.open === false) return;
    opening.set({ state: "opening" });
    resumable.set(null);
    try {
      if (observedPane) await Sessions.observe(props.machine, observedPane);
      else await Sessions.attach(props.machine, props.id);
      opening.set({ state: "ready" });
    } catch (e) {
      opening.set({ state: "failed", message: reason(e) });
      // An agent that exited keeps its conversation: its record says whether `Continue` can reopen it.
      if (!observedPane) {
        try {
          const info = (await Sessions.list(props.machine)).find((i) => i.id === props.id);
          if (info && info.state === "exited" && info.sessionId) resumable.set(info);
        } catch {
          // The listing is a courtesy; the failure above is what the person reads.
        }
      }
    }
  };
  // A session that was open and is not any more (its keeper went, its pane was closed in herdr) is said, not left blank.
  let seen = false;
  effect(() => {
    if (model.view()) seen = true;
    else if (seen && props.open !== false) {
      seen = false;
      untracked(() =>
        opening.set({
          state: "failed",
          message: observedPane
            ? "The agent's pane is gone, or its log can no longer be read."
            : "The session is not open any more. It may have ended.",
        }),
      );
    }
  });
  void open();
  cleanup(() => {
    if (props.open !== false) Sessions.detach(props.machine, props.id);
  });

  const cont = async (info: SessionInfo) => {
    continuing.set(true);
    try {
      const ref = await Sessions.resume(props.machine, {
        agent: info.agent,
        cwd: info.cwd,
        sessionId: info.sessionId!,
      });
      await openSession(ref.machine, ref.id);
      removePanel(sessionKey(props.machine, props.id));
    } catch (e) {
      opening.set({ state: "failed", message: reason(e) });
    } finally {
      continuing.set(false);
    }
  };

  const reconnect = async () => {
    reconnecting.set(true);
    try {
      await props.port.reconnect();
    } catch (e) {
      announce(`Could not reconnect: ${reason(e)}`);
    } finally {
      reconnecting.set(false);
    }
  };

  // The keyboard goes to the message box when the tab opens, and again when `mod+2` asks.
  let focusedOnce = false;
  effect(() => {
    if (!props.active || !model.view() || model.view()!.phase === "authRequired" || focusedOnce) return;
    focusedOnce = true;
    setTimeout(() => composer?.focus(), 0);
  });
  effect(() => {
    if (!props.active) return;
    const copy = (text: string | undefined, done: string, none: string) => {
      if (text === undefined) announce(none);
      else void Clipboard.writeText(text).then(() => notify(done));
    };
    return registerPane({
      focusComposer: () => composer?.focus(),
      copyReply: () => copy(lastReply(model.rows()), "Answer copied", "The agent has not answered yet"),
      copyCode: () =>
        copy(touched.text() ?? lastCode(lastReply(model.rows())), "Code copied", "No code in the last answer"),
      attachFiles: () => composer?.attach(),
      quote: (text) => composer?.quote(text),
      mention: (machine, path) => {
        if (machine !== props.machine || !composer) return false;
        composer.mention(path);
        return true;
      },
    });
  });

  // A request the agent is waiting on is told once, when it arrives.
  let told = "";
  effect(() => {
    const w = model.view()?.waiting[0];
    const key = w ? w.requestId : "";
    if (key === told) return;
    told = key;
    if (!w) return;
    const what = w.ask === "permission" ? [w.title, w.subject].filter(Boolean).join(": ") : (w.message ?? "a question");
    untracked(() => announce(`Needs you: ${oneLine(visibleText(what), 200)}`));
  });

  const machineName = () => Herdr.machines().find((m) => m.id === props.machine)?.name ?? props.machine;
  const local = () => Herdr.machines().find((m) => m.id === props.machine)?.local ?? true;

  const drop = (uris: string[]) => {
    if (composer) composer.drop(uris);
    else sending.set({ machine: props.machine, folder: model.view()?.cwd ?? "~", paths: [] });
  };

  const ctx = {
    machine: props.machine,
    id: props.id,
    get cwd() {
      return model.view()?.cwd ?? "";
    },
    model,
  };

  const waiting = (v: SessionView) => v.waiting.length > 0;

  return (
    <View
      class="min-h-0 flex-1 bg-background"
      onFileDragEnter={() => dropping.set(true)}
      onFileDragLeave={() => dropping.set(false)}
      onFileDrop={({ uris }) => {
        dropping.set(false);
        drop(uris);
      }}
    >
      <If
        when={model.view()}
        else={
          <If
            when={failure()}
            else={
              <Empty
                fill
                icon="clock"
                title="Opening the session…"
                hint={observedPane ? "Reading the agent's log." : "Replaying the conversation."}
              />
            }
          >
            {(message) => (
              <Empty fill icon="alert" title="Cannot open this session" hint={message()}>
                <View class="flex-row gap-2">
                  <Btn label="Try again" onPress={() => void open()} />
                  <If when={resumable()}>
                    {(info) => (
                      <Btn
                        label="Continue"
                        name="Continue the conversation in a new session"
                        variant="primary"
                        loading={continuing()}
                        onPress={() => void cont(info())}
                      />
                    )}
                  </If>
                </View>
              </Empty>
            )}
          </If>
        }
      >
        {(live) => {
          const view = latest(live);
          return (
            <>
              <SessionHeader
                view={view()}
                machine={props.machine}
                active={props.active}
                machineName={machineName()}
                onDetails={() => details.set(true)}
                onShowTerminal={observedPane ? () => void showTerminal(props.machine, observedPane) : undefined}
              />
              <If when={view().connectionLost}>
                <View role="alert" class="flex-row items-center gap-2 border-b border-border bg-muted px-4 py-2">
                  <Text class="min-w-0 flex-1 text-xs text-foreground">{`Not connected to ${machineName()}. The agent keeps running; reconnect to carry on.`}</Text>
                  <Btn small label="Reconnect" loading={reconnecting()} onPress={() => void reconnect()} />
                </View>
              </If>
              <If when={view().observed && view().observed!.link !== "following" && view().observed!.linkText}>
                <View class="border-b border-border bg-muted px-4 py-2">
                  <Text class="text-xs text-muted-foreground">{view().observed!.linkText}</Text>
                </View>
              </If>
              <If when={view().observed?.problem}>
                <View role="alert" class="border-b border-border bg-muted px-4 py-2">
                  <Text class="text-xs text-foreground">{view().observed!.problem}</Text>
                </View>
              </If>
              <If when={view().observed}>{(observed) => <SessionActivity observed={observed()} />}</If>
              <If when={view().phase === "authRequired"}>
                <SessionSignin
                  view={view()}
                  where={local() ? "this computer" : machineName()}
                  active={props.active}
                  signin={signin}
                />
              </If>
              <If when={view().phase !== "authRequired"}>
                <SessionPlan plan={view().plan} running={view().running} />
                <SessionTranscript
                  ctx={ctx}
                  panel={sessionKey(props.machine, props.id)}
                  active={props.active}
                  atEnd={atEnd}
                  unseen={unseen}
                  waiting={() => waiting(view())}
                  opening={() => view().phase === "connecting"}
                />
                <If when={view().waiting[0]?.ask === "permission"}>
                  <PermissionDock machine={props.machine} id={props.id} view={view()} />
                </If>
                <If when={view().waiting[0]?.ask === "question"}>
                  <SessionQuestion machine={props.machine} id={props.id} view={view()} />
                </If>
                <SessionComposer
                  machine={props.machine}
                  id={props.id}
                  port={props.port}
                  view={view}
                  onHandle={(h) => {
                    composer = h;
                  }}
                />
              </If>
              <SessionOverview
                open={details()}
                onClose={() => details.set(false)}
                machine={props.machine}
                id={props.id}
              />
              <If when={dropping()}>
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  class="absolute inset-0 items-center justify-center border-2 border-dashed border-primary bg-background/80"
                >
                  <Text class="text-sm font-medium text-foreground">
                    {local() ? "Drop to attach to the message" : `Drop to send to ${machineName()}`}
                  </Text>
                </View>
              </If>
            </>
          );
        }}
      </If>
    </View>
  );
}
