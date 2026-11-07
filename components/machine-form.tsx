import { Herdr } from "herdr-desktop/native";
import { announce, cleanup, signal, Text, View } from "nsh";

import type { MachineInput, MachineView, TestResult } from "herdr-desktop/native";

import { Autocomplete, Btn, Field, FieldRow, Icon, NumberField, SettingRow, Switch } from "#kit";
import { destinationError, fieldOfRejection, NAME_MISSING, portError, sessionError } from "#lib/machine-rules";

type FieldName = "name" | "destination" | "port" | "session";

/** A rejection of `Herdr.saveMachine` (Rust checks again whatever the form let through): shown next to its field, or as a line of its own. */
interface Rejection {
  field?: FieldName;
  message: string;
}

/** Why a call threw, as text. */
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `Add machine` and `Edit <name>`: a remote machine reached with the system `ssh`. There is no password and no key
 * field on purpose: ssh brings its own identity (config, keys, agent) and its own host-key trust, so the form only says
 * what to do in a terminal when that is not set up. Mistakes show under their field on blur and on submit; the rules
 * (`lib/machine-rules.ts`) mirror the ones Rust enforces, and Rust's own message is shown too. What was typed stays
 * through a failed save or a failed test. `Test connection` connects once without adding anything.
 */
export function MachineForm(props: {
  machine?: MachineView;
  onClose: () => void;
  onSaved: (machine: MachineView) => void;
}) {
  // The form is mounted fresh each time it opens, so every field starts from the machine's own values.
  const m = props.machine;
  const name = signal(m?.name ?? "");
  const dest = signal(m?.dest ?? "");
  const port = signal<number | null>(m?.port ?? null);
  const session = signal(m?.session ?? "");
  const enabled = signal(m?.enabled ?? true);
  const touched = signal<Partial<Record<FieldName, boolean>>>({});
  const rejection = signal<Rejection | undefined>(undefined);
  const result = signal<TestResult | undefined>(undefined);
  const testing = signal(false);
  const hosts = signal<string[]>(Herdr.sshHosts());
  /** Counts tests started: a test that finishes after the form was closed is not shown. */
  let generation = 0;
  cleanup(() => generation++);

  const rules = (): Record<FieldName, string | undefined> => ({
    name: name().trim() === "" ? NAME_MISSING : undefined,
    destination: destinationError(dest().trim()),
    port: portError(port()),
    session: sessionError(session().trim()),
  });
  const errorOf = (field: FieldName): string | undefined => {
    const own = touched()[field] ? rules()[field] : undefined;
    return own ?? (rejection()?.field === field ? rejection()?.message : undefined);
  };
  const touch = (...fields: FieldName[]) =>
    touched.set({ ...touched(), ...Object.fromEntries(fields.map((f) => [f, true])) });
  /** An edit makes the last test and the last rejection stale: they described the old values. */
  const edited = () => {
    result.set(undefined);
    rejection.set(undefined);
  };
  const input = (): MachineInput => ({
    id: props.machine?.id ?? null,
    name: name().trim(),
    dest: dest().trim(),
    port: port(),
    session: session().trim() === "" ? null : session().trim(),
    enabled: enabled(),
  });
  const firstError = (fields: FieldName[]) => fields.map((f) => rules()[f]).find((e) => e !== undefined);

  const test = async () => {
    // A test needs a destination: an empty one would test this computer.
    touch("destination", "port", "session");
    if (firstError(["destination", "port", "session"])) return;
    const mine = ++generation;
    testing.set(true);
    result.set(undefined);
    let outcome: TestResult;
    try {
      outcome = await Herdr.testConnection({ ...input(), name: name().trim() || dest().trim(), enabled: true });
    } catch (e) {
      outcome = { ok: false, message: reason(e) };
    }
    if (mine !== generation) return;
    testing.set(false);
    result.set(outcome);
    announce(outcome.message);
  };

  const save = () => {
    touch("name", "destination", "port", "session");
    if (firstError(["name", "destination", "port", "session"])) return;
    try {
      const saved = Herdr.saveMachine(input());
      announce(props.machine ? `Saved ${saved.name}` : `Added ${saved.name}`);
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      const message = reason(e);
      rejection.set({ field: fieldOfRejection(message), message });
      // A field shows and announces its own; a whole-save failure has no field to do it.
      if (fieldOfRejection(message) === undefined) announce(message);
    }
  };

  const target = () =>
    dest().trim() !== "" && destinationError(dest().trim()) === undefined ? dest().trim() : "<destination>";
  const editing = () => props.machine !== undefined;

  return (
    <View class="gap-4">
      <View class="gap-1">
        <Text role="header" class="text-base font-medium text-foreground">
          {editing() ? `Edit ${props.machine?.name ?? "machine"}` : "Add machine"}
        </Text>
        <Text class="text-sm text-muted-foreground">Another computer where herdr runs, reached over ssh.</Text>
      </View>
      <FieldRow>
        <Field
          autoFocus
          required
          label="Name *"
          placeholder="build-box"
          reserve
          value={name()}
          onChange={(v) => {
            name.set(v);
            edited();
          }}
          onSubmit={save}
          onBlur={() => touch("name")}
          error={errorOf("name")}
        />
      </FieldRow>
      <FieldRow>
        <Autocomplete
          required
          label="Destination *"
          placeholder="user@host or an ssh config alias"
          mono
          reserve
          value={dest()}
          onChange={(v) => {
            dest.set(v);
            edited();
          }}
          suggestions={hosts()}
          onSubmit={save}
          onBlur={() => touch("destination")}
          error={errorOf("destination")}
          hint={errorOf("destination") ? undefined : "Hosts of your ssh config are suggested."}
        />
      </FieldRow>
      <View class="flex-row items-start gap-3">
        <NumberField
          label="Port"
          placeholder="22"
          min={1}
          max={65535}
          allowOutOfRange
          steppers={false}
          format={{ maximumFractionDigits: 0, useGrouping: false }}
          reserve
          value={port()}
          onChange={(v) => {
            port.set(v);
            edited();
          }}
          onSubmit={save}
          onBlur={() => touch("port")}
          error={errorOf("port")}
        />
        <Field
          mono
          label="herdr session"
          placeholder="default"
          reserve
          value={session()}
          onChange={(v) => {
            session.set(v);
            edited();
          }}
          onSubmit={save}
          onBlur={() => touch("session")}
          error={errorOf("session")}
        />
      </View>
      <SettingRow
        label="Switched on"
        description="Off keeps the machine listed without connecting to it."
        control={<Switch label="Connect to this machine" checked={enabled()} onChange={(v) => enabled.set(v)} />}
      />
      <View class="gap-1 rounded-md bg-muted px-3 py-3">
        <Text class="text-sm text-foreground">
          ssh signs you in: it uses your ssh config, keys and agent. There is no password or key to enter here.
        </Text>
        <Text class="text-sm text-muted-foreground">
          {`Password login is not supported. If the host is new to you or asks for a password, run ssh ${target()} once in a terminal to trust the host and log in.`}
        </Text>
      </View>
      <If when={result()}>
        {(outcome) => (
          <View class="flex-row items-start gap-2">
            <Icon
              name={outcome().ok ? "circle-check" : "alert"}
              size={16}
              tone={outcome().ok ? "success" : "destructive"}
            />
            <Text class={`min-w-0 flex-1 text-sm ${outcome().ok ? "text-foreground" : "text-destructive"}`}>
              {outcome().message}
            </Text>
          </View>
        )}
      </If>
      <If when={rejection() && rejection()?.field === undefined}>
        <View class="flex-row items-start gap-2">
          <Icon name="alert" size={16} tone="destructive" />
          <Text class="min-w-0 flex-1 text-sm text-destructive">{rejection()?.message ?? ""}</Text>
        </View>
      </If>
      <View class="flex-row items-center justify-end gap-2">
        <Btn variant="ghost" label="Cancel" onPress={() => props.onClose()} />
        <Btn label="Test connection" loading={testing()} onPress={() => void test()} />
        <Btn variant="primary" label={editing() ? "Save" : "Add"} hint="↵" onPress={save} />
      </View>
    </View>
  );
}
