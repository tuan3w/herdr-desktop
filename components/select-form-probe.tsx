import { mount, signal, Text, View } from "nsh";

import { Btn } from "./kit/button";
import { Form } from "./kit/field-parts";
import { createForm } from "./kit/form";
import { SelectField } from "./kit/select";
import { ThemeRoot } from "./kit/theme-root";

/** Test entry only (`select-form.test.tsx`): a required select in a form, and the count of submits that went through. */
function Lab() {
  const model = signal<"" | "a" | "b">("");
  const done = signal(0);
  const form = createForm({ onFormSubmit: () => done.update((n) => n + 1) });
  return (
    <ThemeRoot>
      <View class="flex-1 gap-3 bg-background p-4">
        <Form form={form}>
          <SelectField
            label="Model"
            required
            placeholder="Choose a model"
            items={[
              { value: "a", title: "4.5 (recommended)" },
              { value: "b", title: "4.0" },
            ]}
            value={model()}
            onChange={(v) => model.set(v)}
          />
          <Btn variant="primary" label="Save" onPress={() => form.submit()} />
        </Form>
        <Text>{`submitted:${done()}`}</Text>
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
