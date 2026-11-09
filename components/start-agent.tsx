import { Herdr } from "herdr-desktop/native";
import { announce, computed, effect, signal, Text, untracked, View } from "nsh";

import { Autocomplete, Btn, Field, FieldRow, Icon, Modal, SelectField } from "#kit";
import { AGENT_KINDS, folderError } from "#lib/agent-kinds";
import { allRows, board, revision } from "#lib/herdr";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `Start a terminal agent`: pick the machine, the folder and the agent, and herdr opens a workspace there with the agent
 * running in it. Nothing is started without a connected machine, and a start that fails keeps what was typed and
 * says what happened (when the agent did not start, the shell it opened stays: the message says so). The machine,
 * folder and agent are remembered between openings, because starting several agents in one folder is the usual case;
 * the name is not, because it belongs to one agent. The agents offered are the ones that machine's herdr can start
 * when it says (an older herdr does not: then every known kind is offered).
 * `onStarted` gets the new pane after the dialog closed, so the caller can open it.
 */
export function StartAgent(props: {
  open: boolean;
  onClose: () => void;
  onStarted: (machine: string, pane: string) => void;
}) {
  const machine = signal("");
  const folder = signal("");
  const agent = signal(AGENT_KINDS[0]?.kind ?? "");
  const name = signal("");
  /** What each machine's herdr says it can start, by machine id; empty or absent means unknown. */
  const startable = signal<Record<string, string[]>>({});
  const asked = new Set<string>();
  const attempted = signal(false);
  const busy = signal(false);
  const failure = signal<string | undefined>(undefined);

  /** The machines that are switched on, with whether each can be started on now. */
  const choices = computed(() => {
    revision();
    const online = new Set(
      Herdr.machineStatuses()
        .filter((s) => s.state === "online")
        .map((s) => s.id),
    );
    return Herdr.machines()
      .filter((m) => m.enabled)
      .map((m) => ({
        value: m.id,
        title: online.has(m.id) ? m.name : `${m.name} (not connected)`,
        disabled: !online.has(m.id),
      }));
  });
  const ready = () => choices().find((c) => c.value === machine() && !c.disabled) !== undefined;
  /** Folders agents already run in on the chosen machine: what the person most likely wants again. */
  const known = computed(() => {
    const rows = allRows(board());
    return [...new Set(rows.filter((r) => r.machine === machine() && r.cwd).map((r) => r.cwd as string))];
  });
  const offered = computed(() => {
    const said = startable()[machine()] ?? [];
    const some = AGENT_KINDS.filter((k) => said.includes(k.kind));
    return some.length > 0 ? some : AGENT_KINDS;
  });

  effect(() => {
    if (!props.open) return;
    untracked(() => {
      attempted.set(false);
      failure.set(undefined);
      busy.set(false);
      name.set("");
      // The remembered machine may have gone or dropped off: start from one that works.
      if (!ready()) machine.set(choices().find((c) => !c.disabled)?.value ?? choices()[0]?.value ?? "");
    });
  });

  // Each machine is asked once; one that did not answer is asked again when the dialog next opens.
  effect(() => {
    const id = machine();
    if (!props.open || id === "") return;
    untracked(() => {
      if (asked.has(id)) return;
      asked.add(id);
      Herdr.agentKinds(id).then(
        (kinds) => startable.update((all) => ({ ...all, [id]: kinds })),
        () => asked.delete(id),
      );
    });
  });
  effect(() => {
    if (!offered().some((k) => k.kind === agent())) agent.set(offered()[0]!.kind);
  });

  const start = async () => {
    attempted.set(true);
    if (busy() || !ready() || folderError(folder())) return;
    busy.set(true);
    failure.set(undefined);
    const where = machine();
    try {
      const made = await Herdr.startAgent(where, {
        cwd: folder().trim(),
        agent: agent(),
        name: name().trim() || undefined,
      });
      announce(`Started ${AGENT_KINDS.find((k) => k.kind === agent())?.title ?? agent()}`);
      props.onClose();
      props.onStarted(where, made.paneId);
    } catch (e) {
      failure.set(reason(e));
      announce(reason(e));
    } finally {
      busy.set(false);
    }
  };

  const machineMistake = () => {
    if (choices().length === 0) return "No machine is switched on. Open Machines to add one.";
    return ready() ? undefined : "That machine is not connected. Pick another, or open Machines.";
  };
  const folderMistake = () => (attempted() ? folderError(folder()) : undefined);

  return (
    <Modal
      open={props.open}
      onClose={() => props.onClose()}
      title="Start a terminal agent"
      description="Starts the agent in a new herdr workspace in that folder."
      disablePointerDismissal={busy()}
      actions={
        <>
          <Btn variant="ghost" label="Cancel" onPress={() => props.onClose()} />
          <Btn
            variant="primary"
            label="Start agent"
            hint="↵"
            loading={busy()}
            disabled={!ready()}
            onPress={() => void start()}
          />
        </>
      }
    >
      <View class="gap-3">
        <FieldRow>
          <SelectField label="Machine *" items={choices()} value={machine()} onChange={(id) => machine.set(id)} />
        </FieldRow>
        <If when={machineMistake()}>
          {(message) => (
            <View class="flex-row items-start gap-2">
              <Icon name="alert" size={16} tone="destructive" />
              <Text class="min-w-0 flex-1 text-sm text-destructive">{message()}</Text>
            </View>
          )}
        </If>
        <FieldRow>
          <Autocomplete
            autoFocus
            required
            mono
            reserve
            label="Folder *"
            placeholder="/home/you/project"
            value={folder()}
            onChange={(v) => {
              folder.set(v);
              failure.set(undefined);
            }}
            suggestions={known()}
            onSubmit={() => void start()}
            onBlur={() => attempted.set(true)}
            error={folderMistake()}
            hint="An absolute path on that machine."
          />
        </FieldRow>
        <FieldRow>
          <Field
            label="Name"
            value={name()}
            onChange={(v) => name.set(v)}
            onSubmit={() => void start()}
            hint="The agent's kind when left empty"
          />
        </FieldRow>
        <FieldRow>
          <SelectField
            label="Agent"
            items={offered().map((k) => ({ value: k.kind, title: k.title }))}
            value={agent()}
            onChange={(kind) => agent.set(kind)}
          />
        </FieldRow>
        <If when={failure()}>
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
