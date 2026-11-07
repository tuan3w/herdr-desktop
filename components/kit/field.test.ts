import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { checkConstraints, createField, createTextSlot, type FieldOptions, type Validator, type Violation } from "./field";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A field with a control holding a string value; `type` is what a keystroke does. */
function make(options: FieldOptions & { required?: boolean; violations?: (v: unknown) => Violation[] } = {}) {
  const value = signal<unknown>("");
  const field = createField(options);
  field.attach({ value: () => value(), required: () => options.required, violations: options.violations });
  const type = (v: unknown) => {
    value.set(v);
    field.valueChanged(v);
  };
  return { field, value, type };
}

test("with nothing asked, a field stays unknown through typing and blur", () => {
  const { field, type } = make({ required: true });
  type("a");
  type("");
  field.blurred();
  expect(field.valid()).toBeNull();
  expect(field.errors()).toEqual([]);
  expect(field.touched()).toBe(true);
});

test("an empty required field is no error until it was changed or a submit checked it", async () => {
  const fresh = checkConstraints({ required: true, empty: true, violations: [] }, false);
  expect(fresh.state.valid).toBe(true);
  expect(fresh.errors).toEqual([]);
  const touched = checkConstraints({ required: true, empty: true, violations: [] }, true);
  expect(touched.state.valueMissing).toBe(true);
  expect(touched.errors).toEqual(["Enter a value."]);
  // any other broken constraint counts at once
  const bad = checkConstraints({ required: true, empty: true, violations: [{ key: "badInput" }] }, false);
  expect(bad.state.valid).toBe(false);
  expect(bad.state.badInput).toBe(true);
});

test("onSubmit: nothing is checked until the first submit, then every change is", async () => {
  let submits = 0;
  const { field, type } = make({
    required: true,
    form: { mode: () => "onSubmit", submitCount: () => submits, errorsFor: () => [], clearError: () => {}, values: () => ({}), submit: () => true, register: () => () => {} },
    validate: () => (v) => (v === "taken" ? "Taken." : null),
  });
  type("taken");
  expect(field.valid()).toBeNull();
  await field.validate();
  expect(field.valid()).toBe(false);
  expect(field.errors()).toEqual(["Taken."]);
  submits = 1;
  type("free");
  await wait(0);
  expect(field.valid()).toBe(true);
  type("");
  await wait(0);
  expect(field.valid()).toBe(false);
  expect(field.validity().state.valueMissing).toBe(true);
});

test("onBlur: leaving checks it, and an error that shows goes as soon as the value is fixed", async () => {
  const { field, type } = make({ validationMode: () => "onBlur", required: true, validate: () => (v) => (String(v).length < 3 ? "Too short." : null) });
  type("ab");
  expect(field.valid()).toBeNull();
  field.blurred();
  await wait(0);
  expect(field.errors()).toEqual(["Too short."]);
  expect(field.validity().state.customError).toBe(true);
  // fixing it clears the error on the keystroke, before the next blur
  type("abc");
  await wait(0);
  expect(field.valid()).toBe(true);
  expect(field.errors()).toEqual([]);
  type("");
  expect(field.valid()).toBe(true);
  field.blurred();
  await wait(0);
  expect(field.validity().state.valueMissing).toBe(true);
});

test("leaving an empty required field in onBlur mode is an error even when it was never typed in", async () => {
  const { field } = make({ validationMode: () => "onBlur", required: true });
  field.setFocused(true);
  expect(field.focused()).toBe(true);
  field.blurred();
  await wait(0);
  expect(field.valid()).toBe(false);
  expect(field.focused()).toBe(false);
});

test("onChange: every change is checked; debounce waits for the last; empty is checked at once", async () => {
  const calls: unknown[] = [];
  const { field, type } = make({
    validationMode: () => "onChange",
    validationDebounceTime: () => 30,
    validate: () => (v) => {
      calls.push(v);
      return v === "bad" ? "Wrong." : null;
    },
  });
  type("b");
  type("ba");
  type("bad");
  expect(calls).toEqual([]);
  await wait(70);
  expect(calls).toEqual(["bad"]);
  expect(field.errors()).toEqual(["Wrong."]);
  type("");
  await wait(0);
  expect(calls).toEqual(["bad", ""]);
  expect(field.valid()).toBe(true);
});

test("broken constraints come before the rule, and the rule decides when they pass", async () => {
  let ran = 0;
  const { field, type } = make({
    validationMode: () => "onBlur",
    violations: (v) => (String(v).length > 3 ? [{ key: "tooLong", message: "At most 3." }] : []),
    validate: () => () => {
      ran++;
      return "Rule";
    },
  });
  type("abcd");
  field.blurred();
  await wait(0);
  expect(field.errors()).toEqual(["At most 3."]);
  expect(ran).toBe(0);
  type("abc");
  field.blurred();
  await wait(0);
  expect(field.errors()).toEqual(["Rule"]);
  expect(ran).toBe(1);
});

test("an async rule makes the field unknown while it runs; a result superseded by a newer value is dropped", async () => {
  const resolvers: Record<string, (m: string | null) => void> = {};
  const rule: Validator = (v) => new Promise((resolve) => (resolvers[String(v)] = resolve));
  const { field, type } = make({ validationMode: () => "onChange", validate: () => rule });
  type("a");
  await wait(0);
  expect(field.pending()).toBe(true);
  expect(field.valid()).toBeNull();
  type("b");
  await wait(0);
  resolvers.a?.("Old.");
  await wait(0);
  // the answer for "a" came late and is not the field's
  expect(field.errors()).toEqual([]);
  resolvers.b?.("New.");
  await wait(0);
  expect(field.errors()).toEqual(["New."]);
  expect(field.pending()).toBe(false);
});

test("a failed async rule keeps what was published", async () => {
  const { field, type } = make({ validationMode: () => "onChange", validate: () => (v) => (v === "x" ? "Wrong." : Promise.reject(new Error("offline"))) });
  type("x");
  await wait(0);
  expect(field.valid()).toBe(false);
  type("y");
  await wait(0);
  expect(field.valid()).toBe(false);
  expect(field.errors()).toEqual(["Wrong."]);
  expect(field.pending()).toBe(false);
});

test("the owner's message beats the form's, which beats the rules'; any of them makes it invalid", async () => {
  const owner = signal<string | undefined>(undefined);
  const server = signal<string[]>([]);
  const { field, type } = make({
    validationMode: () => "onChange",
    name: () => "handle",
    error: () => owner(),
    validate: () => () => "Rule",
    form: { mode: () => "onSubmit", submitCount: () => 0, errorsFor: () => server(), clearError: () => {}, values: () => ({}), submit: () => true, register: () => () => {} },
  });
  type("x");
  await wait(0);
  expect(field.errors()).toEqual(["Rule"]);
  server.set(["Handle taken."]);
  expect(field.errors()).toEqual(["Handle taken."]);
  expect(field.invalid()).toBe(true);
  owner.set("The owner's.");
  expect(field.errors()).toEqual(["The owner's."]);
  owner.set(undefined);
  server.set([]);
  expect(field.errors()).toEqual(["Rule"]);
  expect(field.invalid()).toBe(false);
});

test("a disabled field is neither valid nor invalid by its rules, but an owner's error still holds", async () => {
  const off = signal(false);
  const { field, type } = make({ validationMode: () => "onChange", disabled: () => off(), validate: () => () => "Wrong." });
  type("x");
  await wait(0);
  expect(field.valid()).toBe(false);
  off.set(true);
  expect(field.valid()).toBeNull();
  expect(field.errors()).toEqual([]);
  field.setFocused(true);
  expect(field.focused()).toBe(false);
  const forced = make({ disabled: () => true, invalid: () => true });
  expect(forced.field.valid()).toBe(false);
});

test("dirty is a comparison with the first value, and filled follows the value", () => {
  const { field, type } = make();
  expect(field.dirty()).toBe(false);
  expect(field.filled()).toBe(false);
  type("a");
  expect(field.dirty()).toBe(true);
  expect(field.filled()).toBe(true);
  type("");
  expect(field.dirty()).toBe(false);
  expect(field.filled()).toBe(false);
  const lists = make();
  lists.type(["a"]);
  lists.type([]);
  expect(lists.field.filled()).toBe(false);
});

test("dirty and touched given by the owner are not overwritten by the user", () => {
  const { field, type } = make({ dirty: () => false, touched: () => false });
  type("a");
  field.blurred();
  expect(field.dirty()).toBe(false);
  expect(field.touched()).toBe(false);
});

test("a control gone takes its pending check with it", async () => {
  const value = signal<unknown>("");
  const field = createField({ validationMode: () => "onChange", validationDebounceTime: () => 20, validate: () => () => "Wrong." });
  const detach = field.attach({ value: () => value() });
  value.set("a");
  field.valueChanged("a");
  detach();
  await wait(50);
  expect(field.valid()).toBeNull();
});

test("a text slot joins its parts and follows them leaving", () => {
  const slot = createTextSlot();
  const off = slot.add(() => "Agent name");
  slot.add(() => "");
  const second = slot.add(() => "required");
  expect(slot.text()).toBe("Agent name required");
  second();
  expect(slot.text()).toBe("Agent name");
  off();
  expect(slot.text()).toBe("");
});
