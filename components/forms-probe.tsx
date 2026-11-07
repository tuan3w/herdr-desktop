import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import { Btn } from "./kit/button";
import { CheckRow } from "./kit/check";
import { Form } from "./kit/field-parts";
import { Field, FieldRow, SearchField } from "./kit/fields";
import { createForm, type FormErrors } from "./kit/form";
import { NumberField } from "./kit/number-field";
import { SettingRow } from "./kit/settings";
import { Switch } from "./kit/switch";
import { ThemeRoot } from "./kit/theme-root";

/** Test entry only (`forms.test.tsx`): a form of a few kinds of field, a form of 40, and counters of what a keystroke costs. */

let timers = 0;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  timers++;
  return realSetTimeout(handler, ms, ...args);
}) as typeof setTimeout;

const NAMES = Array.from({ length: 40 }, (_, i) => `f${i}`);

function MachineForm() {
  const name = signal("");
  const host = signal("");
  const delay = signal<number | null>(null);
  const retries = signal<number | null>(3);
  const query = signal("");
  const errors = signal<FormErrors | undefined>(undefined);
  const done = signal("");
  const changes = signal(0);
  const form = createForm({
    errors: () => errors(),
    onFormSubmit: (values) => done.set(JSON.stringify(values)),
  });
  return (
    <View class="gap-3 p-4">
      <Form form={form}>
        <FieldRow>
          <Field
            name="name"
            required
            label="Name *"
            value={name()}
            onChange={(v) => name.set(v)}
            hint="Shown in the sidebar"
          />
        </FieldRow>
        <FieldRow>
          <Field
            name="host"
            address
            label="Host"
            value={host()}
            onChange={(v) => host.set(v)}
            validate={(v) => (String(v) !== "" && !String(v).includes("@") ? "Host needs user@host." : null)}
          />
        </FieldRow>
        <FieldRow>
          <NumberField
            name="delay"
            label="Delay (s)"
            unit="s"
            min={0}
            max={100000}
            value={delay()}
            onChange={(v) => {
              delay.set(v);
              changes.set(changes() + 1);
            }}
          />
          <NumberField
            name="retries"
            label="Retries"
            min={0}
            max={99}
            snapOnStep
            value={retries()}
            onChange={(v) => retries.set(v)}
          />
        </FieldRow>
        <Btn variant="primary" label="Save" onPress={() => form.submit()} />
      </Form>
      <Btn label="Server error" onPress={() => errors.set({ host: "Host already added." })} />
      <SearchField value={query()} onChange={(v) => query.set(v)} placeholder="Search agents" />
      <Text>{`done:${done()}`}</Text>
      <Text>{`delay:${delay() === null ? "null" : delay()}`}</Text>
      <Text>{`retries:${retries() === null ? "null" : retries()}`}</Text>
      <Text>{`changes:${changes()}`}</Text>
      <Text>{`query:${query()}`}</Text>
    </View>
  );
}

/** A required box, a number with a minimum, and a setting row of a switch: what a form must refuse and a label must do. */
function Rules() {
  const agree = signal(false);
  const done = signal("");
  const typed = signal<number | null>(null);
  const calls = signal("");
  const wrap = signal(false);
  const other = signal("");
  const form = createForm({ onFormSubmit: (values) => done.set(JSON.stringify(values)) });
  return (
    <View class="gap-3 p-4">
      <Form form={form}>
        <CheckRow name="agree" required label="I agree" checked={agree()} onChange={(v) => agree.set(v)}>
          <Text>I agree to the terms</Text>
        </CheckRow>
        <NumberField
          name="floor"
          label="At least ten"
          min={10}
          value={typed()}
          onChange={(v) => {
            typed.set(v);
            calls.set(`${calls()}${v},`);
          }}
        />
        <Btn variant="primary" label="Send" onPress={() => form.submit()} />
      </Form>
      <SettingRow
        label="Wrap the lines"
        onPress={() => wrap.set(!wrap())}
        control={<Switch label="Wrap" checked={wrap()} onChange={(v) => wrap.set(v)} />}
      />
      {/* Somewhere to put the focus: a press on a label does not move it off a field. */}
      <Field label="Elsewhere" value={other()} onChange={(v) => other.set(v)} />
      <Text>{`sent:${done()}`}</Text>
      <Text>{`wrap:${wrap()}`}</Text>
      <Text>{`calls:${calls()}`}</Text>
    </View>
  );
}

function Many() {
  const values = Object.fromEntries(NAMES.map((n) => [n, signal("")]));
  const started = performance.now();
  const form = createForm({ validationMode: () => "onBlur" });
  const view = (
    <Form form={form}>
      <Each of={NAMES}>
        {(name) => (
          <Field
            name={name()}
            label={`Field ${name()}`}
            value={values[name()]?.() ?? ""}
            onChange={(v) => values[name()]?.set(v)}
          />
        )}
      </Each>
    </Form>
  );
  const mounted = `mounted:${Math.round(performance.now() - started)}`;
  const shown = signal(-1);
  return (
    <View class="gap-2 p-4">
      <Text>{mounted}</Text>
      <Button onPress={() => shown.set(timers)} accessibilityLabel="Count timers">
        <Text>{`timers:${shown()}`}</Text>
      </Button>
      {view}
    </View>
  );
}

function Lab() {
  const page = signal<"machine" | "many" | "rules">("machine");
  return (
    <ThemeRoot>
      <View class="flex-1 bg-background">
        <View class="flex-row gap-2 p-2">
          <Button onPress={() => page.set("machine")} accessibilityLabel="Machine">
            <Text>Machine</Text>
          </Button>
          <Button onPress={() => page.set("many")} accessibilityLabel="Many fields">
            <Text>Many fields</Text>
          </Button>
          <Button onPress={() => page.set("rules")} accessibilityLabel="Rules">
            <Text>Rules</Text>
          </Button>
        </View>
        <If
          when={page() === "machine"}
          else={
            <If when={page() === "rules"} else={<Many />}>
              <Rules />
            </If>
          }
        >
          <MachineForm />
        </If>
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
