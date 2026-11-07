import { announce, computed, effect, signal, Text, untracked, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import { AGENT_KINDS, folderError } from "../lib/agent-kinds";
import { board, revision } from "../lib/herdr";
import { Autocomplete, Btn, FieldRow, Icon, Modal, SelectField } from "./kit";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `New agent session`: pick the machine, the folder and the agent, and herdr opens a workspace there with the agent
 * running in it. Nothing is started without a connected machine, and a start that fails keeps what was typed and
 * says what happened (when the agent did not start, the shell it opened stays: the message says so). The machine,
 * folder and agent are remembered between openings, because starting several agents in one folder is the usual case.
 * `onStarted` gets the new pane after the dialog closed, so the caller can open it.
 */
export function StartAgent(props: { open: boolean; onClose: () => void; onStarted: (machine: string, pane: string) => void }) {
  const machine = signal("");
  const folder = signal("");
  const agent = signal(AGENT_KINDS[0]?.kind ?? "");
  const attempted = signal(false);
  const busy = signal(false);
  const failure = signal<string | undefined>(undefined);

  /** The machines that are switched on, with whether each can be started on now. */
  const choices = computed(() => {
    revision();
    const online = new Set(Herdr.machineStatuses().filter((s) => s.state === "online").map((s) => s.id));
    return Herdr.machines()
      .filter((m) => m.enabled)
      .map((m) => ({ value: m.id, title: online.has(m.id) ? m.name : `${m.name} (not connected)`, disabled: !online.has(m.id) }));
  });
  const ready = () => choices().find((c) => c.value === machine() && !c.disabled) !== undefined;
  /** Folders agents already run in on the chosen machine: what the person most likely wants again. */
  const known = computed(() => {
    const rows = [board().needsYou, board().toReview, board().working, board().idle].flat();
    return [...new Set(rows.filter((r) => r.machine === machine() && r.cwd).map((r) => r.cwd as string))];
  });

  effect(() => {
    if (!props.open) return;
    untracked(() => {
      attempted.set(false);
      failure.set(undefined);
      busy.set(false);
      // The remembered machine may have gone or dropped off: start from one that works.
      if (!ready()) machine.set(choices().find((c) => !c.disabled)?.value ?? choices()[0]?.value ?? "");
    });
  });

  const start = async () => {
    attempted.set(true);
    if (busy() || !ready() || folderError(folder())) return;
    busy.set(true);
    failure.set(undefined);
    const where = machine();
    try {
      const made = await Herdr.startAgent(where, { cwd: folder().trim(), agent: agent() });
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
      title="New agent session"
      description="Starts the agent in a new herdr workspace in that folder."
      disablePointerDismissal
      actions={
        <>
          <Btn variant="ghost" label="Cancel" onPress={() => props.onClose()} />
          <Btn variant="primary" label="Start agent" hint="↵" loading={busy()} disabled={!ready()} onPress={() => void start()} />
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
          <SelectField label="Agent" items={AGENT_KINDS.map((k) => ({ value: k.kind, title: k.title }))} value={agent()} onChange={(kind) => agent.set(kind)} />
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
