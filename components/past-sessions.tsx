import { Herdr, Sessions } from "herdr-desktop/native";
import { announce, computed, effect, Scroll, signal, Text, untracked, View } from "nsh";

import type { AgentRoute, PastSessionsView, PastSessionView } from "herdr-desktop/native";

import { Btn, CheckRow, Clipped, Empty, Icon, Modal, SelectField, Skeleton } from "#kit";
import { modifiedText } from "#lib/files";
import { agentLabel, epochSeconds, startFailure } from "#lib/new-session";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The tallest the list grows before it scrolls inside the dialog, in points. */
const LIST_HEIGHT = 360;

/**
 * `Past sessions`: the conversations an agent kept in its own store on a machine, newest first, each with its
 * title, folder and age, and `Continue`, which starts a new session that loads it (`Sessions.resume`). The agent
 * is fixed when the caller knows it (`agent`), else chosen from what the machine runs. With a `cwd` the list starts in
 * that folder, with `All folders` to widen it. An agent that cannot list or cannot reload says so instead of showing an
 * empty list that looks like "nothing happened yet". Listing runs the agent briefly and can take seconds: the list is
 * busy meanwhile, and a failure keeps its reason and a `Try again`.
 */
export function PastSessions(props: {
  open: boolean;
  onClose: () => void;
  machine: string;
  agent?: string;
  cwd?: string;
  onResumed: (machine: string, id: string) => void;
}) {
  const routes = signal<AgentRoute[]>([]);
  const picked = signal("");
  const everywhere = signal(false);
  const result = signal<PastSessionsView | undefined>(undefined);
  const loading = signal(false);
  const failure = signal<string | undefined>(undefined);
  const resuming = signal<string | null>(null);
  const resumeFailure = signal<string | undefined>(undefined);
  const machineName = computed(() => Herdr.machines().find((m) => m.id === props.machine)?.name ?? props.machine);
  const agent = () => props.agent ?? picked();
  const folder = () => (props.cwd && !everywhere() ? props.cwd : null);
  let latest = 0;

  /** Reads what the agent remembers, newest request wins: a slow answer for an agent the person left is dropped. */
  async function load() {
    const which = agent();
    if (which === "") return;
    const mine = ++latest;
    loading.set(true);
    result.set(undefined);
    failure.set(undefined);
    try {
      const past = await Sessions.history(props.machine, which, folder());
      if (mine !== latest) return;
      result.set(past);
      announce(past.sessions.length === 0 ? "No past sessions" : `${past.sessions.length} past sessions`);
    } catch (e) {
      if (mine !== latest) return;
      result.set(undefined);
      failure.set(reason(e));
      announce(reason(e));
    } finally {
      if (mine === latest) loading.set(false);
    }
  }

  // Opening starts from nothing: no list of an earlier opening, and the agents the machine runs when none was given.
  effect(() => {
    if (!props.open) return;
    untracked(() => {
      result.set(undefined);
      resumeFailure.set(undefined);
      everywhere.set(false);
      picked.set("");
    });
    if (props.agent) return;
    void Sessions.probe(props.machine).then(
      (found) => {
        routes.set(found);
        picked.set(found[0]?.id ?? "");
        if (found.length === 0) failure.set(`No agent runs on ${machineName()}.`);
      },
      (e: unknown) => failure.set(reason(e)),
    );
  });
  effect(() => {
    if (!props.open) return;
    agent();
    folder();
    untracked(() => void load());
  });

  async function resume(s: PastSessionView) {
    if (resuming() !== null) return;
    resuming.set(s.sessionId);
    resumeFailure.set(undefined);
    try {
      const made = await Sessions.resume(props.machine, { agent: agent(), cwd: s.cwd, sessionId: s.sessionId });
      announce("Continuing the session");
      props.onClose();
      props.onResumed(made.machine, made.id);
    } catch (e) {
      const failed = startFailure(reason(e), machineName());
      resumeFailure.set(`${failed.text} ${failed.next}`);
      announce(failed.text);
    } finally {
      resuming.set(null);
    }
  }

  const title = (s: PastSessionView) => s.title?.trim() || "Untitled session";
  const age = (s: PastSessionView) => modifiedText(epochSeconds(s.updatedAt), Math.floor(Date.now() / 1000));
  const count = (s: PastSessionView) =>
    s.messageCount === null || s.messageCount === undefined
      ? ""
      : `${s.messageCount} ${s.messageCount === 1 ? "message" : "messages"}`;

  return (
    <Modal
      open={props.open}
      wide
      onClose={() => props.onClose()}
      title="Past sessions"
      description={`Conversations ${agent() ? agentLabel(agent()) : "an agent"} kept on ${machineName()}. Continue loads one into a new session.`}
      actions={<Btn variant="ghost" label="Close" onPress={() => props.onClose()} />}
    >
      <View class="gap-3">
        <View class="flex-row flex-wrap items-center gap-3">
          <If when={!props.agent}>
            <SelectField
              label="Agent"
              items={routes().map((r) => ({ value: r.id, title: r.label }))}
              value={picked()}
              onChange={(id) => picked.set(id)}
            />
          </If>
          <If when={props.cwd}>
            <CheckRow label="All folders" checked={everywhere()} onChange={(on) => everywhere.set(on)}>
              <Text class="text-sm text-foreground">All folders</Text>
            </CheckRow>
          </If>
        </View>
        <If when={failure()}>
          {(message) => (
            <View class="flex-row flex-wrap items-center gap-2">
              <Icon name="alert" size={16} tone="destructive" />
              <Text class="min-w-0 flex-1 text-sm text-destructive">{message()}</Text>
              <Btn small label="Try again" onPress={() => void load()} />
            </View>
          )}
        </If>
        <If when={loading()}>
          <View accessibilityLabel="Loading past sessions" class="gap-2">
            <Skeleton class="h-9 w-full" />
            <Skeleton class="h-9 w-full" />
            <Skeleton class="h-9 w-full" />
          </View>
        </If>
        <If when={result()}>
          {(past) => (
            <>
              <If when={!past().canList}>
                <Empty
                  title="This agent cannot list its past sessions"
                  hint={`${agentLabel(past().agent)} keeps no list the app can read.`}
                />
              </If>
              <If when={past().canList && past().sessions.length === 0}>
                <Empty
                  title="No past sessions"
                  hint={
                    folder()
                      ? "Nothing was kept for this folder. Try All folders."
                      : "Nothing was kept on this machine yet."
                  }
                />
              </If>
              <If when={past().sessions.length > 0}>
                <Scroll style={{ maxHeight: LIST_HEIGHT }}>
                  <View role="group" accessibilityLabel="Past sessions" class="gap-1">
                    <Each of={past().sessions} key={(s: PastSessionView) => s.sessionId}>
                      {(s) => (
                        <View
                          role="group"
                          accessibilityLabel={[title(s()), agentLabel(past().agent), s().cwd, age(s()), count(s())]
                            .filter(Boolean)
                            .join(", ")}
                          class="flex-row items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
                        >
                          <View class="min-w-0 flex-1 gap-1">
                            <Clipped class="text-sm font-medium text-foreground">{title(s())}</Clipped>
                            <Clipped class="font-mono text-xs text-muted-foreground">{s().cwd}</Clipped>
                          </View>
                          <Text class="text-xs text-muted-foreground">
                            {[age(s()), count(s())].filter(Boolean).join(" · ")}
                          </Text>
                          <Btn
                            small
                            label="Continue"
                            name={`Continue ${title(s())}`}
                            disabled={!past().canLoad || (resuming() !== null && resuming() !== s().sessionId)}
                            loading={resuming() === s().sessionId}
                            onPress={() => void resume(s())}
                          />
                        </View>
                      )}
                    </Each>
                  </View>
                </Scroll>
                <If when={!past().canLoad}>
                  <Text class="text-xs text-muted-foreground">{`${agentLabel(past().agent)} cannot reload a conversation, so these can be read but not continued.`}</Text>
                </If>
                <If when={past().more}>
                  <Text class="text-xs text-muted-foreground">
                    There are more than shown. Narrow the list to a folder.
                  </Text>
                </If>
              </If>
            </>
          )}
        </If>
        <If when={resumeFailure()}>
          {(message) => (
            <View class="flex-row items-start gap-2">
              <Icon name="alert" size={16} tone="destructive" />
              <Text class="min-w-0 flex-1 text-sm text-destructive">{message()}</Text>
            </View>
          )}
        </If>
      </View>
    </Modal>
  );
}
