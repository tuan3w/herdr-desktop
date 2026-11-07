import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { createField, type Field, type Validator } from "./field";
import { createForm, type FormController, type FormErrors } from "./form";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A field in the form, with an input that records the focus it was given. */
function join(form: FormController, name: string, options: { required?: boolean; validate?: Validator; input?: boolean; disabled?: () => boolean; initial?: unknown } = {}) {
  const value = signal<unknown>(options.initial ?? "");
  const focused: string[] = [];
  const field: Field = createField({ name: () => name, form: form.api, validate: () => options.validate, disabled: options.disabled });
  const detach = field.attach({
    value: () => value(),
    required: () => options.required,
    focus: options.input === false ? undefined : () => focused.push(name),
  });
  const type = (v: unknown) => {
    value.set(v);
    field.valueChanged(v);
  };
  return { field, type, focused, detach };
}

test("submit stops at an invalid field, focuses the first wrong input and does not call onFormSubmit", () => {
  const submitted: Record<string, unknown>[] = [];
  const form = createForm({ onFormSubmit: (v) => submitted.push(v) });
  const a = join(form, "a", { required: true });
  const b = join(form, "b", { required: true });
  expect(form.submit()).toBe(false);
  expect(a.field.valid()).toBe(false);
  expect(b.field.valid()).toBe(false);
  expect(a.focused).toEqual(["a"]);
  expect(b.focused).toEqual([]);
  expect(submitted).toEqual([]);
  a.type("x");
  expect(form.submit()).toBe(false);
  expect(b.focused).toEqual(["b"]);
  b.type("y");
  expect(form.submit()).toBe(true);
  expect(submitted).toEqual([{ a: "x", b: "y" }]);
});

test("a wrong control that is not an input blocks the submit but cannot take the focus: an input after it does", () => {
  const form = createForm();
  const pick = join(form, "agent", { required: true, input: false });
  const name = join(form, "name", { required: true });
  expect(form.submit()).toBe(false);
  expect(pick.field.valid()).toBe(false);
  expect(name.focused).toEqual(["name"]);
  name.type("x");
  expect(form.submit()).toBe(false);
  expect(name.focused).toEqual(["name"]);
  pick.type("claude");
  expect(form.submit()).toBe(true);
});

test("a disabled field is neither validated nor submitted, and a field that left the form is forgotten", () => {
  const off = signal(true);
  const form = createForm();
  const a = join(form, "a", { required: true, disabled: () => off() });
  const b = join(form, "b", { initial: "keep" });
  const c = join(form, "c", { required: true });
  c.detach();
  expect(form.values()).toEqual({ b: "keep" });
  expect(form.submit()).toBe(true);
  expect(a.field.valid()).toBeNull();
  off.set(false);
  expect(form.submit()).toBe(false);
});

test("the form's validation mode is the fields' unless a field says otherwise, and a submit starts revalidation on change", async () => {
  const mode = signal<"onBlur" | "onSubmit">("onBlur");
  const form = createForm({ validationMode: () => mode() });
  const a = join(form, "a", { required: true, validate: (v) => (v === "no" ? "No." : null) });
  expect(a.field.validationMode()).toBe("onBlur");
  a.type("no");
  expect(a.field.valid()).toBeNull();
  a.field.blurred();
  await wait(0);
  expect(a.field.errors()).toEqual(["No."]);
  mode.set("onSubmit");
  const b = join(form, "b", { validate: (v) => (v === "no" ? "No." : null) });
  b.type("no");
  await wait(0);
  expect(b.field.valid()).toBeNull();
  form.submit();
  await wait(0);
  expect(b.field.valid()).toBe(false);
  b.type("ok");
  await wait(0);
  expect(b.field.valid()).toBe(true);
});

test("errors by name: they make the field invalid, go when that field changes, and the others stay", async () => {
  const errors = signal<FormErrors | undefined>({ handle: "Handle taken.", label: ["Wrong label.", "Missing."] });
  const form = createForm({ errors: () => errors() });
  const handle = join(form, "handle");
  const label = join(form, "label");
  expect(handle.field.errors()).toEqual(["Handle taken."]);
  expect(label.field.errors()).toEqual(["Wrong label.", "Missing."]);
  expect(handle.field.valid()).toBe(false);
  handle.type("new-handle");
  expect(handle.field.errors()).toEqual([]);
  expect(handle.field.valid()).toBeNull();
  expect(label.field.valid()).toBe(false);
  // a submit does not go on while an owner's error is still there
  expect(form.submit()).toBe(false);
  expect(label.focused).toEqual(["label"]);
  // new errors replace the old ones as a whole
  errors.set({ handle: "Taken again." });
  expect(handle.field.errors()).toEqual(["Taken again."]);
  expect(label.field.errors()).toEqual([]);
});

test("errors that arrive after a successful submit move to the first field they name, once", () => {
  const errors = signal<FormErrors | undefined>(undefined);
  const form = createForm({ errors: () => errors() });
  const a = join(form, "a");
  const b = join(form, "b");
  expect(form.submit()).toBe(true);
  errors.set({ b: "The server refused." });
  expect(b.focused).toEqual(["b"]);
  expect(a.focused).toEqual([]);
  errors.set({ a: "Also wrong." });
  // no submit in between: nothing moves the focus again
  expect(a.focused).toEqual([]);
});

test("an async rule does not hold a submit back, a sync one does", async () => {
  const submitted: unknown[] = [];
  const form = createForm({ onFormSubmit: (v) => submitted.push(v) });
  join(form, "slow", { initial: "x", validate: () => new Promise((resolve) => setTimeout(() => resolve("Late."), 20)) });
  expect(form.submit()).toBe(true);
  expect(submitted.length).toBe(1);
  join(form, "quick", { initial: "x", validate: () => "Now." });
  expect(form.submit()).toBe(false);
  await wait(40);
});

test("validate checks one field by name, or all, without submitting", async () => {
  const submitted: unknown[] = [];
  const form = createForm({ onFormSubmit: (v) => submitted.push(v) });
  const a = join(form, "a", { required: true });
  const b = join(form, "b", { required: true });
  await form.validate("b");
  expect(a.field.valid()).toBeNull();
  expect(b.field.valid()).toBe(false);
  await form.validate();
  expect(a.field.valid()).toBe(false);
  expect(submitted).toEqual([]);
});
