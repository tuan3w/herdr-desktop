import { Herdr, Sessions } from "herdr-desktop/native";
import { announce, Clipboard, computed, effect, signal, Text, untracked, View } from "nsh";

import type { PhaseName, SessionInfo } from "herdr-desktop/native";

import { PlanSteps } from "#components/plan-steps";
import { SessionOption } from "#components/session-config";
import { Btn, confirmDestructive, Icon, Modal, notify, Progress } from "#kit";
import { revision } from "#lib/herdr";
import { agentLabel } from "#lib/new-session";

/** Where the session stands, in the words the transcript's header uses. */
const PHASE: Record<PhaseName, string> = {
  connecting: "Opening",
  idle: "Waiting for you",
  working: "Working",
  blockedOnPermission: "Needs your permission",
  blockedOnQuestion: "Needs your answer",
  authRequired: "Needs you to sign in",
  ended: "Ended",
};

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One fact of the session: its name above, its value below, and an optional action (copy). */
function Detail(props: {
  label: string;
  value: string;
  mono?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View class="flex-row items-start justify-between gap-3 py-2">
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-xs text-muted-foreground">{props.label}</Text>
        <Text style={{ userSelect: "text" }} class={`text-sm text-foreground ${props.mono ? "font-mono" : ""}`}>
          {props.value}
        </Text>
      </View>
      <If when={props.action}>
        {(action) => <Btn small variant="ghost" label={action().label} onPress={action().onPress} />}
      </If>
    </View>
  );
}

/**
 * The details of one agent session: what it is (agent, machine, folder, id), where it stands, how full its context
 * is, its settings with their choices (mode, model, thinking level), its plan, and `End session`.
 * Ending is the one irreversible thing here and the app may only end a keeper it started: for one it did not start
 * the machine's own refusal is shown as it is, with nothing confirmed and nothing ended. There is no copy of the
 * transcript: the session API does not offer one.
 */
export function SessionOverview(props: { open: boolean; onClose: () => void; machine: string; id: string }) {
  const view = computed(() => {
    revision();
    return props.open ? (Sessions.view(props.machine, props.id) ?? undefined) : undefined;
  });
  const info = signal<SessionInfo | undefined>(undefined);
  const failure = signal<string | undefined>(undefined);
  const ending = signal(false);
  const machineName = computed(() => Herdr.machines().find((m) => m.id === props.machine)?.name ?? props.machine);

  // The keeper's own record (who started it, whether the agent exited) is read when the details open and when the session changes.
  let latest = 0;
  effect(() => {
    revision();
    if (!props.open) return;
    const mine = ++latest;
    void Sessions.list(props.machine).then(
      (all) => {
        if (mine === latest) info.set(all.find((s) => s.id === props.id));
      },
      () => {
        if (mine === latest) info.set(undefined);
      },
    );
  });
  effect(() => {
    if (props.open) untracked(() => failure.set(undefined));
  });

  async function end() {
    failure.set(undefined);
    const record = info();
    // Confirm only what the app may do. A session it did not start is refused by the keeper's own words, shown as they are.
    if (record?.owned || record?.state === "exited") {
      const exited = record.state === "exited";
      const ok = await confirmDestructive({
        title: exited ? "Remove this session?" : "End this session?",
        description: exited
          ? "Its agent has exited. This removes its record from the machine."
          : "This stops the agent and removes its record from the machine. What it was doing is lost.",
        action: exited ? "Remove" : "End session",
      });
      if (!ok) return;
    }
    ending.set(true);
    try {
      await Sessions.kill(props.machine, props.id);
      announce("Session ended");
      notify("Session ended");
      props.onClose();
    } catch (e) {
      failure.set(reason(e));
      announce(reason(e));
    } finally {
      ending.set(false);
    }
  }

  const phase = () => view()?.phase;
  const state = () => {
    const v = view();
    if (!v) return "Not open here. Open the session to see its state.";
    if (v.phase === "ended") return v.endedReason ? `Ended: ${v.endedReason}` : "Ended";
    return v.connectionLost ? `${PHASE[v.phase]} · connection lost` : PHASE[v.phase];
  };

  return (
    <Modal
      open={props.open}
      wide
      onClose={() => props.onClose()}
      title="Session details"
      description={view()?.title ?? undefined}
    >
      <View class="gap-1">
        <Detail label="Agent" value={agentLabel(view()?.agent ?? info()?.agent ?? "")} />
        <Detail label="Machine" value={machineName()} />
        <Detail label="Folder" value={view()?.cwd ?? info()?.cwd ?? ""} mono />
        <Detail
          label="Session id"
          value={props.id}
          mono
          action={{
            label: "Copy id",
            onPress: () => void Clipboard.writeText(props.id).then(() => notify("Session id copied")),
          }}
        />
        <Detail label="State" value={state()} />
        <If when={view()?.contextPercent !== undefined && view()?.contextPercent !== null}>
          <View class="gap-1 py-2">
            <Text class="text-xs text-muted-foreground">Context</Text>
            <Progress
              label="Context used"
              value={view()?.contextPercent ?? 0}
              valueText={`${Math.round(view()?.contextPercent ?? 0)} percent of the context is used`}
            />
            <Text class="text-sm text-foreground">{`${Math.round(view()?.contextPercent ?? 0)}% used`}</Text>
          </View>
        </If>
        <If when={(view()?.options.length ?? 0) > 0}>
          <View class="gap-2 py-2">
            <Text class="text-xs text-muted-foreground">Settings</Text>
            <Each of={view()?.options ?? []} key="index">
              {(option) => <SessionOption machine={props.machine} id={props.id} optionId={option().id} />}
            </Each>
            <If when={phase() === "working"}>
              <Text class="text-xs text-muted-foreground">Settings change between turns: the agent is working.</Text>
            </If>
          </View>
        </If>
        <PlanSteps plan={view()?.plan ?? []} open />
        <View class="mt-2 gap-2 border-t border-border pt-3">
          <If when={failure()}>
            {(message) => (
              <View class="flex-row items-start gap-2">
                <Icon name="alert" size={16} tone="destructive" />
                <Text class="min-w-0 flex-1 text-sm text-destructive">{message()}</Text>
              </View>
            )}
          </If>
          <View class="flex-row">
            <Btn variant="danger" label="End session" loading={ending()} onPress={() => void end()} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
