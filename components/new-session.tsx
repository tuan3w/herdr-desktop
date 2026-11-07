import { Herdr, Sessions } from "herdr-desktop/native";
import { announce, computed, effect, keymap, signal, Text, untracked, View } from "nsh";

import type { AgentRoute, SessionInfo } from "herdr-desktop/native";

import { FolderPicker } from "#components/folder-picker";
import { PastSessions } from "#components/past-sessions";
import { Autocomplete, Btn, Field, FieldRow, Icon, Modal, notify, SelectField, Spinner } from "#kit";
import { allRows, board, revision } from "#lib/herdr";
import {
  agentChoices,
  agentLabel,
  lastStart,
  recentFolders,
  rememberStart,
  type StartFailure,
  sessionFolderError,
  startFailure,
} from "#lib/new-session";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** How long a first message waits for the session to open before the session is handed over without it. */
const OPEN_WAIT_MS = 15000;

/** Waits (polling the session, 100 ms apart) until `id` is open: a message sent while it is `connecting` is refused. */
async function opened(machine: string, id: string): Promise<boolean> {
  for (let waited = 0; waited < OPEN_WAIT_MS; waited += 100) {
    const view = Sessions.view(machine, id);
    if (view && view.phase !== "connecting") return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * `New agent session`: which machine, which folder on it, which agent, and optionally the first message; `Start` opens a
 * chat with that agent (`Sessions.start`) and hands it to `onStarted` after the dialog closed. `project` fills the machine
 * and folder, as a project's `New session` does. Nothing starts on a machine that is not connected or with an agent it
 * does not have; the agents offered are what the machine can run (`Sessions.probe`), the others are listed dimmed with
 * the reason. A failure keeps everything typed and says what happened in the keeper's words and what to do next. The last
 * agent and folder per machine are remembered. `Past sessions` opens the conversations an agent kept, to continue one.
 */
export function NewSession(props: {
  open: boolean;
  onClose: () => void;
  onStarted: (machine: string, id: string) => void;
  project?: { machine: string; folder: string };
}) {
  const machine = signal("");
  const folder = signal("");
  const agent = signal("");
  const prompt = signal("");
  const folderTouched = signal(false);
  const attempted = signal(false);
  const busy = signal(false);
  const failure = signal<StartFailure | undefined>(undefined);
  const routes = signal<AgentRoute[] | undefined>(undefined);
  const probeFailure = signal<StartFailure | undefined>(undefined);
  const sessions = signal<SessionInfo[]>([]);
  const picking = signal(false);
  const history = signal(false);
  let latest = 0;

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
  const machineName = () =>
    choices()
      .find((c) => c.value === machine())
      ?.title.replace(/ \(not connected\)$/, "") ?? machine();

  /** The agents the machine runs, and the ones it lacks. */
  const agents = computed(() => agentChoices(routes() ?? []));
  const missing = () => agents().filter((a) => !a.installed);
  const installed = () => agents().some((a) => a.installed && a.id === agent());
  const probing = () => ready() && routes() === undefined && probeFailure() === undefined;

  const recents = computed(() => {
    const here = machine();
    const rows = allRows(board());
    return recentFolders({
      remembered: lastStart(here).folder,
      sessions: sessions(),
      agents: rows.filter((r) => r.machine === here && r.cwd).map((r) => r.cwd as string),
    });
  });

  /** Asks the machine which agents it runs and which sessions it holds; a slow answer for a machine the person left is dropped. */
  async function look(where: string) {
    const mine = ++latest;
    routes.set(undefined);
    probeFailure.set(undefined);
    sessions.set([]);
    if (where === "" || !ready()) return;
    try {
      const found = await Sessions.probe(where);
      if (mine !== latest) return;
      routes.set(found);
      const wanted = lastStart(where).agent;
      agent.set(found.find((r) => r.id === wanted)?.id ?? found[0]?.id ?? "");
    } catch (e) {
      if (mine !== latest) return;
      routes.set([]);
      agent.set("");
      probeFailure.set(startFailure(reason(e), machineName()));
      announce(reason(e));
      return;
    }
    try {
      const held = await Sessions.list(where);
      if (mine === latest) sessions.set(held);
    } catch {
      // A listing only feeds the suggestions: the form works without it.
    }
  }

  // Opening starts clean: the project's machine and folder, else the last ones used, else the first machine that works.
  effect(() => {
    if (!props.open) return;
    const project = props.project;
    untracked(() => {
      attempted.set(false);
      failure.set(undefined);
      busy.set(false);
      prompt.set("");
      agent.set("");
      const want = project?.machine ?? machine();
      const first =
        choices().find((c) => c.value === want && !c.disabled) ?? choices().find((c) => !c.disabled) ?? choices()[0];
      machine.set(first?.value ?? "");
      folderTouched.set(project !== undefined);
      folder.set(project?.folder ?? lastStart(machine()).folder ?? "");
    });
  });
  // The machine and whether it is connected: a string, so a revision that changes neither does not ask the machine again.
  const target = computed(() => `${machine()}|${ready()}`);
  effect(() => {
    if (!props.open) return;
    target();
    untracked(() => void look(machine()));
  });

  // A first message has several lines: Ctrl+Enter starts, as everywhere a text box takes Enter itself.
  effect(() => {
    if (!props.open) return;
    return keymap.bind("mod+enter", () => void start(), { when: "always" });
  });

  const chooseMachine = (id: string) => {
    machine.set(id);
    failure.set(undefined);
    if (!folderTouched()) folder.set(lastStart(id).folder ?? "");
  };

  async function start() {
    attempted.set(true);
    if (busy() || !ready() || !installed() || sessionFolderError(folder())) return;
    busy.set(true);
    failure.set(undefined);
    const where = machine();
    const which = agent();
    const cwd = folder().trim();
    try {
      const ref = await Sessions.start(where, { agent: which, cwd });
      rememberStart(where, which, cwd);
      const first = prompt().trim();
      if (first !== "") {
        // A session that is still opening refuses a message; once it is open the first one goes before the person sees it.
        const sent = (await opened(ref.machine, ref.id))
          ? await Sessions.send(ref.machine, ref.id, first, [], [])
          : undefined;
        if (!sent || (sent.kind !== "done" && sent.kind !== "queued"))
          notify(
            `The session started, but the first message was not sent${sent ? `: ${sent.message}` : ""}. Send it from the chat.`,
            { type: "error" },
          );
      }
      announce(`Started ${agentLabel(which)}`);
      props.onClose();
      props.onStarted(ref.machine, ref.id);
    } catch (e) {
      const said = startFailure(reason(e), machineName());
      failure.set(said);
      announce(`${said.text} ${said.next}`);
    } finally {
      busy.set(false);
    }
  }

  const machineMistake = () => {
    if (choices().length === 0) return "No machine is switched on. Open Machines to add one.";
    return ready() ? undefined : "That machine is not connected. Pick another, or open Machines.";
  };
  const folderMistake = () => (attempted() ? sessionFolderError(folder()) : undefined);
  const agentMistake = () => {
    if (!attempted() || !ready() || probing() || probeFailure() || installed()) return undefined;
    return "Pick an agent this machine can run.";
  };

  const problem = (said: () => StartFailure) => (
    <View class="flex-row items-start gap-2">
      <Icon name="alert" size={16} tone="destructive" />
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-sm text-destructive">{said().text}</Text>
        <Text class="text-sm text-foreground">{said().next}</Text>
      </View>
    </View>
  );

  return (
    <>
      <Modal
        open={props.open}
        wide
        onClose={() => props.onClose()}
        title="New agent session"
        description="A chat with an agent that runs on the machine and keeps working when this window closes."
        disablePointerDismissal
        actions={
          <>
            <Btn variant="ghost" label="Past sessions" disabled={!ready()} onPress={() => history.set(true)} />
            <Btn variant="ghost" label="Cancel" onPress={() => props.onClose()} />
            <Btn
              variant="primary"
              label="Start"
              hint="Ctrl+↵"
              loading={busy()}
              disabled={!ready() || !installed()}
              onPress={() => void start()}
            />
          </>
        }
      >
        <View class="gap-3">
          <FieldRow>
            <SelectField label="Machine *" items={choices()} value={machine()} onChange={chooseMachine} />
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
                folderTouched.set(true);
                failure.set(undefined);
              }}
              suggestions={recents()}
              onSubmit={() => void start()}
              onBlur={() => attempted.set(true)}
              error={folderMistake()}
              hint="An absolute path on that machine, or ~/ for its home."
            />
          </FieldRow>
          <View class="flex-row">
            <Btn
              small
              variant="ghost"
              icon="folder"
              label="Browse folders"
              disabled={!ready()}
              onPress={() => picking.set(true)}
            />
          </View>
          <FieldRow>
            <SelectField
              label="Agent *"
              disabled={!ready() || probing() || agents().every((a) => !a.installed)}
              placeholder={probing() ? "Looking for agents…" : "No agent to run"}
              items={agents().map((a) => ({
                value: a.id,
                title: a.installed ? a.label : `${a.label} (not installed)`,
                disabled: !a.installed,
              }))}
              value={agent()}
              onChange={(id) => agent.set(id)}
              invalid={agentMistake() !== undefined}
            />
          </FieldRow>
          <If when={probing()}>
            <View class="flex-row items-center gap-2">
              <Spinner size={14} tone="muted-foreground" />
              <Text class="text-sm text-muted-foreground">{`Asking ${machineName()} which agents it can run…`}</Text>
            </View>
          </If>
          <If when={agentMistake()}>
            <Text class="text-sm text-destructive">{agentMistake() ?? ""}</Text>
          </If>
          <If when={routes() && missing().length > 0 && !probeFailure()}>
            <Text class="text-xs text-muted-foreground">{`Not installed on ${machineName()}: ${missing()
              .map((a) => a.label)
              .join(", ")}.`}</Text>
          </If>
          <If when={probeFailure()}>
            {(said) => (
              <View class="gap-2">
                {problem(said)}
                <View class="flex-row">
                  <Btn small label="Try again" onPress={() => void look(machine())} />
                </View>
              </View>
            )}
          </If>
          <If when={routes() && routes()!.length === 0 && !probeFailure()}>
            <Text class="text-sm text-foreground">{`No agent is installed on ${machineName()}. Install omp, Claude Code, Codex or pi there, then reopen this.`}</Text>
          </If>
          <Field
            label="First message (optional)"
            multiline
            placeholder="What should it do first?"
            value={prompt()}
            onChange={(v) => prompt.set(v)}
          />
          <If when={failure()}>{(said) => problem(said)}</If>
        </View>
      </Modal>
      <FolderPicker
        open={picking()}
        machine={machine()}
        start={folder()}
        onClose={() => picking.set(false)}
        onPick={(path) => {
          folder.set(path);
          folderTouched.set(true);
          failure.set(undefined);
        }}
      />
      <PastSessions
        open={history()}
        machine={machine()}
        agent={installed() ? agent() : undefined}
        cwd={sessionFolderError(folder()) ? undefined : folder().trim()}
        onClose={() => history.set(false)}
        onResumed={(m, id) => {
          history.set(false);
          props.onClose();
          props.onStarted(m, id);
        }}
      />
    </>
  );
}
