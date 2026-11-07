import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Btn } from "./kit/button";
import { Field, FieldRow, SearchField } from "./kit/fields";
import { ThemeRoot } from "./kit/theme-root";
import { createForm, type FormErrors } from "./kit/form";
import { Form } from "./kit/field-parts";
import { NumberField } from "./kit/number-field";

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
          <Field name="name" required label="Name *" value={name()} onChange={(v) => name.set(v)} hint="Shown in the sidebar" />
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
          <NumberField name="delay" label="Delay (s)" unit="s" min={0} max={100000} value={delay()} onChange={(v) => { delay.set(v); changes.set(changes() + 1); }} />
          <NumberField name="retries" label="Retries" min={0} max={99} snapOnStep value={retries()} onChange={(v) => retries.set(v)} />
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

function Many() {
  const values = Object.fromEntries(NAMES.map((n) => [n, signal("")]));
  const started = performance.now();
  const form = createForm({ validationMode: () => "onBlur" });
  const view = (
    <Form form={form}>
      <Each of={NAMES}>
        {(name) => <Field name={name()} label={`Field ${name()}`} value={values[name()]?.() ?? ""} onChange={(v) => values[name()]?.set(v)} />}
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
  const page = signal<"machine" | "many">("machine");
  return (
    <ThemeRoot>
      <View class="flex-1 bg-background">
        <View class="flex-row gap-2 p-2">
          <Button onPress={() => page.set("machine")} accessibilityLabel="Machine"><Text>Machine</Text></Button>
          <Button onPress={() => page.set("many")} accessibilityLabel="Many fields"><Text>Many fields</Text></Button>
        </View>
        <If when={page() === "machine"} else={<Many />}>
          <MachineForm />
        </If>
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
