import { announce, computed, effect, signal, Text, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import type { MachineStatus, MachineView } from "herdr-desktop/native";
import { revision } from "../lib/herdr";
import { linkGlyph, linkText } from "../lib/machine-state";
import { MachineForm } from "./machine-form";
import { StatusGlyph } from "./status-glyph";
import { Btn, Clipped, confirmDestructive, Empty, Modal, notify, Switch } from "./kit";

interface Row {
  machine: MachineView;
  status: MachineStatus | undefined;
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a row says about its machine's agents: how many there are, and how many wait for the person. */
function Agents(props: { status: MachineStatus | undefined }) {
  return (
    <If when={props.status && props.status.state === "online" ? props.status : undefined}>
      {(status) => (
        <View class="items-end gap-1">
          <Text class="text-sm text-muted-foreground">{plural(status().agents, "agent", "agents")}</Text>
          <If when={status().needsYou > 0}>
            <View class="flex-row items-center gap-2">
              <StatusGlyph status="blocked" size={12} />
              <Text class="text-sm font-medium text-foreground">{`${status().needsYou} need you`}</Text>
            </View>
          </If>
        </View>
      )}
    </If>
  );
}

/**
 * The machines herdr is read from: this computer, which is always listed, and the ones added over ssh. Each row says
 * how its link is (a shape and words: `reconnecting in 4 s`, `Needs attention: <what to do>`), how many agents it has and
 * how many need the person, and offers what can be done about it: switch it off, `Retry`, `Edit`, `Remove` (which asks
 * first). The list follows the engine's revision, and a retry's countdown ticks once a second while the list is open.
 */
export function Machines(props: { open: boolean; onClose: () => void }) {
  /** Moves after this dialog changed a machine and once a second for a countdown: the engine's tick may come a moment later. */
  const local = signal(0);
  const form = signal<{ open: boolean; machine?: MachineView }>({ open: false });

  const rows = computed<Row[]>(() => {
    revision();
    local();
    const statuses = new Map(Herdr.machineStatuses().map((s) => [s.id, s]));
    return Herdr.machines().map((machine) => ({ machine, status: statuses.get(machine.id) }));
  });

  effect(() => {
    if (!props.open) return;
    const timer = setInterval(() => {
      if (rows().some((r) => r.status?.retryInSecs !== null && r.status?.retryInSecs !== undefined)) local.update((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  });

  const fail = (message: string) => notify(message, { lasting: true });

  const switchOn = (m: MachineView, on: boolean) => {
    try {
      Herdr.saveMachine({ id: m.id, name: m.name, dest: m.dest, port: m.port ?? null, session: m.session ?? null, enabled: on });
      local.update((n) => n + 1);
      announce(`${m.name} switched ${on ? "on" : "off"}`);
    } catch (e) {
      fail(reason(e));
    }
  };

  const remove = async (m: MachineView) => {
    const confirmed = await confirmDestructive({
      title: `Remove ${m.name}?`,
      description: `herdr and its agents keep running on ${m.name}. This app forgets the machine and which finished agents you reviewed there.`,
      action: "Remove machine",
    });
    if (!confirmed) return;
    try {
      Herdr.removeMachine(m.id);
      local.update((n) => n + 1);
      notify(`Removed ${m.name}`);
    } catch (e) {
      fail(reason(e));
    }
  };

  const openForm = (machine?: MachineView) => form.set({ open: true, machine });

  return (
    <>
      <Modal
        open={props.open}
        onClose={() => props.onClose()}
        title="Machines"
        description="Where herdr runs. Other computers are reached over ssh with your own ssh config and keys."
        wide
        actions={
          <>
            <Btn variant="ghost" label="Close" onPress={() => props.onClose()} />
            <Btn variant="primary" icon="plus" label="Add machine" onPress={() => openForm()} />
          </>
        }
      >
        <View class="gap-1">
          <Each of={rows()} key={(r: Row) => r.machine.id}>
            {(row) => (
              <View class="flex-row items-center gap-3 border-b border-border py-3">
                <StatusGlyph status={row().status ? linkGlyph(row().status!.state) : "unknown"} size={16} />
                <View class="min-w-0 flex-1 gap-1">
                  <Clipped class="text-sm font-medium text-foreground">{row().machine.name}</Clipped>
                  <Clipped lines={2} class="text-sm text-muted-foreground">{row().status ? linkText(row().status!) : "Not started"}</Clipped>
                  <If when={!row().machine.local}>
                    <Clipped class="text-xs text-muted-foreground">
                      {`${row().machine.dest}${row().machine.port ? `:${row().machine.port}` : ""}${row().machine.session ? ` · session ${row().machine.session}` : ""}`}
                    </Clipped>
                  </If>
                </View>
                <Agents status={row().status} />
                <If when={!row().machine.local}>
                  <View class="flex-row items-center gap-2">
                    <If when={row().status?.state === "offline" || row().status?.state === "attention"}>
                      <Btn
                        small
                        label="Retry"
                        name={`Retry ${row().machine.name}`}
                        onPress={() => {
                          Herdr.reconnect(row().machine.id);
                          local.update((n) => n + 1);
                        }}
                      />
                    </If>
                    <Switch label={`Connect to ${row().machine.name}`} checked={row().machine.enabled} onChange={(on) => switchOn(row().machine, on)} />
                    <Btn small label="Edit" name={`Edit ${row().machine.name}`} onPress={() => openForm(row().machine)} />
                    <Btn small variant="danger" label="Remove" name={`Remove ${row().machine.name}`} onPress={() => void remove(row().machine)} />
                  </View>
                </If>
              </View>
            )}
          </Each>
          <If when={rows().length <= 1}>
            <Empty title="Only this computer" hint="Add a machine to watch agents that run on another computer over ssh." />
          </If>
        </View>
      </Modal>
      <MachineForm
        open={form().open}
        machine={form().machine}
        onClose={() => form.set({ ...form(), open: false })}
        onSaved={() => local.update((n) => n + 1)}
      />
    </>
  );
}
