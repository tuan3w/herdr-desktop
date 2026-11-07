import { Herdr } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, signal, Text, View } from "nsh";

import type { MachineStatus, MachineView } from "herdr-desktop/native";

import { MachineForm } from "#components/machine-form";
import { StatusGlyph } from "#components/status-glyph";
import { Btn, Clipped, confirmDestructive, Empty, notify, Switch } from "#kit";
import { revision } from "#lib/herdr";
import { linkGlyph, linkText } from "#lib/machine-state";

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

/** The machine being added (`{}`) or edited, or `null` for the list. Settings' Escape reads it: one layer back before it closes. */
export const machineForm = signal<{ machine?: MachineView } | null>(null);

/**
 * The machines herdr is read from, as a page of Settings: this computer, which is always listed, and the ones added over ssh.
 * Each row says how its link is (a shape and words: `reconnecting in 4 s`, `Needs attention: <what to do>`), how many agents it
 * has and how many need the person, and offers what can be done about it: switch it off, `Retry`, `Edit`, `Remove` (which asks
 * first). Add and Edit replace the list with the form in the same page (`MachineForm`), never a dialog over a dialog. The list
 * follows the engine's revision, and a retry's countdown ticks once a second while the page is open.
 */
export function Machines() {
  /** Moves after this page changed a machine and once a second for a countdown: the engine's tick may come a moment later. */
  const local = signal(0);
  cleanup(() => machineForm.set(null));

  const rows = computed<Row[]>(() => {
    revision();
    local();
    const statuses = new Map(Herdr.machineStatuses().map((s) => [s.id, s]));
    return Herdr.machines().map((machine) => ({ machine, status: statuses.get(machine.id) }));
  });

  effect(() => {
    const timer = setInterval(() => {
      if (rows().some((r) => r.status?.retryInSecs !== null && r.status?.retryInSecs !== undefined))
        local.update((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  });

  const fail = (message: string) => notify(message, { lasting: true });

  const switchOn = (m: MachineView, on: boolean) => {
    try {
      Herdr.saveMachine({
        id: m.id,
        name: m.name,
        dest: m.dest,
        port: m.port ?? null,
        session: m.session ?? null,
        enabled: on,
      });
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

  const openForm = (machine?: MachineView) => machineForm.set({ machine });

  return (
    <If
      when={machineForm()}
      else={
        <View class="gap-3">
          <View class="flex-row items-start justify-between gap-6">
            <Text class="min-w-0 flex-1 text-sm text-muted-foreground">
              Where herdr runs. Other computers are reached over ssh with your own ssh config and keys.
            </Text>
            <Btn variant="primary" icon="plus" label="Add machine" onPress={() => openForm()} />
          </View>
          <View>
            <Each of={rows()} key={(r: Row) => r.machine.id}>
              {(row) => (
                <View class="flex-row items-center gap-3 border-t border-border py-3">
                  <StatusGlyph status={row().status ? linkGlyph(row().status!.state) : "unknown"} size={16} />
                  <View class="min-w-0 flex-1 gap-1">
                    <Clipped class="text-sm font-medium text-foreground">{row().machine.name}</Clipped>
                    <Clipped lines={2} class="text-xs text-muted-foreground">
                      {row().status ? linkText(row().status!) : "Not started"}
                    </Clipped>
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
                      <Switch
                        label={`Connect to ${row().machine.name}`}
                        checked={row().machine.enabled}
                        onChange={(on) => switchOn(row().machine, on)}
                      />
                      <Btn
                        small
                        label="Edit"
                        name={`Edit ${row().machine.name}`}
                        onPress={() => openForm(row().machine)}
                      />
                      <Btn
                        small
                        variant="danger"
                        label="Remove"
                        name={`Remove ${row().machine.name}`}
                        onPress={() => void remove(row().machine)}
                      />
                    </View>
                  </If>
                </View>
              )}
            </Each>
          </View>
          <If when={rows().length <= 1}>
            <Empty
              title="Only this computer"
              hint="Add a machine to watch agents that run on another computer over ssh."
            />
          </If>
        </View>
      }
    >
      {(open) => (
        <MachineForm
          machine={open().machine}
          onClose={() => machineForm.set(null)}
          onSaved={() => local.update((n) => n + 1)}
        />
      )}
    </If>
  );
}
