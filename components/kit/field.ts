import { computed, context, cleanup, effect, signal, untracked } from "nsh";

/**
 * The contract between a field and the control in it, built the way Base UI builds `Field` and shaped by this host.
 *
 * A `FieldRoot` (field-parts.tsx; `Labeled` is one) owns a `Field`: touched, dirty, filled, focused, validity, the label
 * and the description. A control (`Field`, `NumberField`, later a `Select`, `Checkbox`...) calls `useFieldControl` once in
 * its body: it registers its value, and from then on the field knows every change, validates by its mode, takes part in
 * the surrounding form, and gives the control the name and the hint a screen reader reads.
 *
 * What is different from Base UI, and why:
 * - there is no DOM: no ids, no `aria-labelledby`, no `htmlFor`. The label and the description are registered text and
 *   the control reads them as `accessibilityLabel` and `accessibilityHint` (which is where an input has them here);
 * - there is no native constraint validation: a control reports what is wrong with its value as `Violation`s, `required`
 *   is checked here, and `validate` is the custom part;
 * - an input can take the keyboard focus from code (`focus()`), other views cannot: a control passes `focus` only if
 *   it is an input, and `Form` moves to the first invalid one of those.
 */

export type ValidationMode = "onSubmit" | "onBlur" | "onChange";

/** Base UI's `ValidityState` keys, the ones a control here can break. */
export type ValidityKey =
  | "valueMissing"
  | "badInput"
  | "rangeUnderflow"
  | "rangeOverflow"
  | "stepMismatch"
  | "tooShort"
  | "tooLong"
  | "patternMismatch"
  | "customError";

export type ValidityFlags = Record<ValidityKey, boolean>;

/** Which constraints are broken; `valid` is `null` while it is unknown (nothing checked yet, or an async rule is running). */
export interface Validity extends ValidityFlags {
  valid: boolean | null;
}

export interface FieldValidity {
  state: Validity;
  /** The first message, "" when valid. */
  error: string;
  errors: string[];
  value: unknown;
  initialValue: unknown;
}

/** A way a control's value breaks its own rules (not `valueMissing`: `required` is the field's). */
export interface Violation {
  key: Exclude<ValidityKey, "customError">;
  /** Replaces the default message of the key. */
  message?: string;
}

/** Defaults in English, sentence case, saying what to do (`design/typography.md`). */
export const MESSAGES: Record<Exclude<ValidityKey, "customError">, string> = {
  valueMissing: "Enter a value.",
  badInput: "The value cannot be read.",
  rangeUnderflow: "The value is too small.",
  rangeOverflow: "The value is too large.",
  stepMismatch: "The value does not fit the step.",
  tooShort: "Enter a longer value.",
  tooLong: "Enter a shorter value.",
  patternMismatch: "Wrong format.",
};

export const NEUTRAL: Validity = {
  valid: null,
  valueMissing: false,
  badInput: false,
  rangeUnderflow: false,
  rangeOverflow: false,
  stepMismatch: false,
  tooShort: false,
  tooLong: false,
  patternMismatch: false,
  customError: false,
};

export type ValidateResult = string | string[] | null | undefined | void;

/**
 * A rule of the field's own. Return the message(s) when the value is wrong, nothing or "" when it is right. Async is fine,
 * but under `validationMode="onSubmit"` it does not hold the submit back. `values` are those of the form's named fields.
 */
export type Validator = (value: unknown, values: Record<string, unknown>) => ValidateResult | Promise<ValidateResult>;

export const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/** Equal as a control's values are: the same primitive, or lists of the same items. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

/** A message, a list of them or nothing, as a list without the empty ones. */
export function toList(result: unknown): string[] {
  if (result === null || result === undefined || result === "") return [];
  return ([] as unknown[]).concat(result).filter((m): m is string => typeof m === "string" && m !== "");
}

export interface Constraints {
  required: boolean;
  empty: boolean;
  violations: readonly Violation[];
}

/**
 * The state of a value against the constraints the control reports. `valueMissing` only counts once the field has been
 * touched by the user or by a submit (`dirty`): an empty required field that nobody changed is not an error to show, it
 * would flag every field of a fresh form (Base UI's rule). Any other broken constraint counts at once.
 */
export function checkConstraints(c: Constraints, dirty: boolean): { state: Validity; errors: string[] } {
  const state: Validity = { ...NEUTRAL, valid: true };
  const errors: string[] = [];
  for (const v of c.violations) {
    state[v.key] = true;
    errors.push(v.message ?? MESSAGES[v.key]);
  }
  if (c.required && c.empty && !state.valueMissing) {
    state.valueMissing = true;
    errors.push(MESSAGES.valueMissing);
  }
  if (state.valueMissing && errors.length === 1 && !dirty) {
    state.valueMissing = false;
    errors.length = 0;
  }
  state.valid = errors.length === 0;
  return { state, errors };
}

/** A line of text built from parts that come and go (a label, a description, a legend). */
export interface TextSlot {
  add(text: () => string): () => void;
  text(): string;
}

export function createTextSlot(): TextSlot {
  const parts = signal<readonly (() => string)[]>([]);
  const text = computed(() =>
    parts()
      .map((part) => part())
      .filter(Boolean)
      .join(" "),
  );
  return {
    add(part) {
      parts.set([...parts(), part]);
      return () => parts.set(parts().filter((p) => p !== part));
    },
    text,
  };
}

/** What a field is to the form around it. */
export interface FormMember {
  name(): string | undefined;
  disabled(): boolean;
  valid(): boolean | null;
  value(): unknown;
  /** Checks it now as a submit does; resolves when its rules (async ones too) are done. */
  validate(): Promise<void>;
  /** Moves the keyboard focus to it: only inputs have it. */
  focus?: () => void;
  /** What a screen reader hears when this one is the reason a submit stopped. */
  summary(): string;
}

/** What a field asks of the form around it (`createForm` in form.ts makes it). */
export interface FormApi {
  mode(): ValidationMode;
  submitCount(): number;
  /** The messages the owner (a server, a rule) gave this field name. */
  errorsFor(name: string | undefined): string[];
  /** The owner's messages for `name` end when its field changes. */
  clearError(name: string | undefined): void;
  values(): Record<string, unknown>;
  /** Validates and submits as a button would; returns whether it submitted. */
  submit(): boolean;
  register(member: FormMember): () => void;
}

/** What a control tells its field about itself. */
export interface ControlRegistration {
  /** The value as the form submits it. Read reactively. */
  value(): unknown;
  empty?(value: unknown): boolean;
  required?(): boolean | undefined;
  violations?(value: unknown): readonly Violation[];
  /** An input moves the keyboard focus to itself; a view cannot, and leaves it out. */
  focus?(): void;
  /** The name to submit under when the field has none. */
  name?(): string | undefined;
}

export interface FieldOptions {
  name?: () => string | undefined;
  disabled?: () => boolean | undefined;
  /** The owner says it is wrong, whatever the rules say (Base UI's `invalid`). */
  invalid?: () => boolean | undefined;
  /** The owner's message for it (`Labeled`'s `error`): shown first, and it makes the field invalid. */
  error?: () => string | string[] | undefined;
  dirty?: () => boolean | undefined;
  touched?: () => boolean | undefined;
  validate?: () => Validator | undefined;
  validationMode?: () => ValidationMode | undefined;
  validationDebounceTime?: () => number | undefined;
  form?: FormApi;
}

export interface Field {
  name(): string | undefined;
  disabled(): boolean;
  /** The owner or the form says it is wrong. */
  invalid(): boolean;
  touched(): boolean;
  dirty(): boolean;
  filled(): boolean;
  focused(): boolean;
  /** `false` while wrong, `true` while right, `null` when not known: before any check, while an async rule runs, or disabled. */
  valid(): boolean | null;
  /** An async rule is running. */
  pending(): boolean;
  validity(): FieldValidity;
  /** What to show now: the owner's messages, else the form's for this name, else those of the rules. None while disabled. */
  errors(): string[];
  validationMode(): ValidationMode;
  validationDebounceTime(): number;
  label: TextSlot;
  description: TextSlot;
  /** A control starts reporting. Returns what ends it. */
  attach(control: ControlRegistration): () => void;
  /** The control's value changed. */
  valueChanged(value: unknown): void;
  setFocused(on: boolean): void;
  /** The control lost the keyboard focus: touched, and checked in `onBlur` mode. Normalize the value first. */
  blurred(): void;
  /** Checks now, as a submit does (and counts the field as changed). With no `value`, the control's. */
  validate(value?: unknown): Promise<void>;
  /** Moves the keyboard focus to the control, when it is an input. */
  focus(): boolean;
}

const blank = (): FieldValidity => ({ state: NEUTRAL, error: "", errors: [], value: null, initialValue: null });

/**
 * The state machine of one field. No view in it: `useFieldControl` and `FieldRoot` give it a control and a place, and the
 * unit tests drive it directly.
 */
export function createField(options: FieldOptions = {}): Field {
  const form = options.form;
  const control = signal<ControlRegistration | undefined>(undefined);
  const touchedState = signal(false);
  const dirtyState = signal(false);
  const filled = signal(false);
  const focused = signal(false);
  const pending = signal(false);
  const data = signal<FieldValidity>(blank());
  let markedDirty = false;
  let commitId = 0;
  let timer: number | undefined;
  let initialCaptured = false;

  const name = () => options.name?.() ?? control()?.name?.();
  const disabled = () => !!options.disabled?.();
  const dirty = () => options.dirty?.() ?? dirtyState();
  const touched = () => options.touched?.() ?? touchedState();
  const mode = () => options.validationMode?.() ?? form?.mode() ?? "onSubmit";
  const debounce = () => options.validationDebounceTime?.() ?? 0;
  const owner = () => toList(options.error?.());
  const fromForm = () => form?.errorsFor(name()) ?? [];
  const invalid = () => options.invalid?.() === true || owner().length > 0 || fromForm().length > 0;
  const valid = () => (invalid() ? false : disabled() ? null : data().state.valid);
  const errors = () => {
    if (disabled()) return [];
    const own = owner();
    if (own.length > 0) return own;
    const given = fromForm();
    return given.length > 0 ? given : data().errors;
  };
  const shouldValidateOnChange = () =>
    mode() === "onChange" || (mode() === "onSubmit" && (form?.submitCount() ?? 0) > 0);

  const read = (value: unknown): { state: Validity; errors: string[] } => {
    const c = control();
    if (!c) return { state: { ...NEUTRAL, valid: true }, errors: [] };
    return checkConstraints(
      { required: !!c.required?.(), empty: (c.empty ?? isEmpty)(value), violations: c.violations?.(value) ?? [] },
      markedDirty,
    );
  };

  const publish = (state: Validity, errs: string[], value: unknown) => {
    pending.set(false);
    data.set({
      state,
      error: errs[0] ?? "",
      errors: state.valid === false ? errs : [],
      value,
      initialValue: data().initialValue,
    });
  };

  const commit = async (value: unknown, revalidate = false): Promise<void> => {
    const id = ++commitId;
    clearTimeout(timer);
    timer = undefined;
    const native = read(value);
    if (revalidate) {
      // Only an error that shows is retired as the user fixes the value; checking a field that is still fine waits for its boundary.
      if (data().state.valid !== false || !control()) return;
      if (!native.state.valueMissing) {
        publish({ ...NEUTRAL, valid: true }, [], value);
        return;
      }
      // Still missing: other broken constraints wait for blur or submit, a stale custom error goes.
      if (Object.entries(native.state).some(([k, v]) => v === true && k !== "valueMissing" && k !== "valid")) return;
      publish(native.state, native.errors, value);
      return;
    }
    let state = native.state;
    let errs = native.errors;
    // Broken constraints come first; the field's own rule runs when they pass, or always while validating on change.
    if (errs.length === 0 || shouldValidateOnChange()) {
      const rule = options.validate?.();
      const raw: unknown = rule?.(value, form?.values() ?? {});
      let result: ValidateResult;
      if (raw !== null && typeof raw === "object" && "then" in raw) {
        // Unknown while it runs: neutral, but what must block a submit stays (broken constraints; a previous custom error outside onSubmit).
        if (state.valid === false) publish(state, errs, value);
        else if (mode() === "onSubmit" || !data().state.customError) publish({ ...state, valid: null }, errs, value);
        pending.set(true);
        try {
          result = await (raw as Promise<ValidateResult>);
        } catch {
          // A failed rule keeps what was published, so a hiccup cannot retire an error and unblock a submit.
          if (id === commitId) pending.set(false);
          return;
        }
        if (id !== commitId) return;
        const fresh = read(value);
        state = fresh.state;
        errs = fresh.errors;
      } else result = raw as ValidateResult;
      const custom = toList(result);
      if (custom.length > 0) {
        state = { ...state, valid: false, customError: true };
        errs = custom;
      }
    }
    publish(state, errs, value);
  };

  const change = (value: unknown, cancelPending = false) => {
    clearTimeout(timer);
    timer = undefined;
    commitId++;
    if (cancelPending) {
      pending.set(false);
      return;
    }
    const onChange = shouldValidateOnChange();
    if (onChange && !isEmpty(value) && debounce() > 0) {
      timer = setTimeout(() => void commit(value), debounce());
    } else void commit(value, !onChange);
  };

  const field: Field = {
    name,
    disabled,
    invalid,
    touched,
    dirty,
    filled: () => filled(),
    focused: () => focused(),
    valid,
    pending: () => pending(),
    validity: () => data(),
    errors,
    validationMode: mode,
    validationDebounceTime: debounce,
    label: createTextSlot(),
    description: createTextSlot(),
    attach(c) {
      if (control() !== undefined) change(undefined, true);
      control.set(c);
      const value = untracked(() => c.value());
      if (!initialCaptured) {
        initialCaptured = true;
        data.set({ ...data(), initialValue: value });
      }
      filled.set(!(c.empty ?? isEmpty)(value));
      const unregister = form?.register({
        name,
        disabled,
        valid,
        value: () => c.value(),
        validate: () => field.validate(),
        focus: c.focus ? () => c.focus?.() : undefined,
        summary: () => [field.label.text(), errors().join(" ")].filter(Boolean).join(": "),
      });
      return () => {
        if (control() !== c) return;
        control.set(undefined);
        change(undefined, true);
        unregister?.();
      };
    },
    valueChanged(value) {
      form?.clearError(name());
      if (options.dirty?.() === undefined) {
        const changed = !same(value, data().initialValue);
        if (changed) markedDirty = true;
        dirtyState.set(changed);
      } else if (options.dirty()) markedDirty = true;
      filled.set(!(control()?.empty ?? isEmpty)(value));
      change(value);
    },
    setFocused(on) {
      if (on && disabled()) return;
      focused.set(on);
    },
    blurred() {
      if (options.touched?.() === undefined) touchedState.set(true);
      focused.set(false);
      const c = control();
      // Leaving a field empty is an error in this mode (design/forms.md), where Base UI waits for the first change.
      if (mode() === "onBlur" && c) {
        markedDirty = true;
        void commit(untracked(() => c.value()));
      }
    },
    validate(value) {
      markedDirty = true;
      const c = control();
      return commit(value === undefined ? (c ? untracked(() => c.value()) : data().value) : value);
    },
    focus() {
      const c = control();
      if (!c?.focus) return false;
      c.focus();
      return true;
    },
  };
  return field;
}

/** The field around the control being made. */
export const FieldScope = context<Field | undefined>(undefined);
/** The form around a field. */
export const FormScope = context<FormApi | undefined>(undefined);
/** A `Fieldset` makes its fields disabled together and names the group. */
export const FieldsetScope = context<{ disabled(): boolean; legend: TextSlot } | undefined>(undefined);
/** One item of a group (a checkbox, a radio) with a label of its own, inside a field. */
export const ItemScope = context<{ disabled(): boolean; label: TextSlot } | undefined>(undefined);

export interface ControlOptions {
  /** The value as the form submits it: a getter, read reactively. A change of it is a change of the field. */
  value: () => unknown;
  required?: () => boolean | undefined;
  /** What counts as empty (default: `null`, `undefined`, "" and `[]`). */
  empty?: (value: unknown) => boolean;
  violations?: (value: unknown) => readonly Violation[];
  focus?: () => void;
  disabled?: () => boolean | undefined;
  name?: () => string | undefined;
}

export interface FieldControl {
  field: Field;
  name(): string | undefined;
  /** Disabled by its own prop, its field, its fieldset or its item. */
  disabled(): boolean;
  /** Show the error look (red edge): the field is invalid. */
  invalid(): boolean;
  /** The accessible name from the field's label, `undefined` when there is none. */
  label(): string | undefined;
  /** What a screen reader gets after the name: the error when one shows, else the description. */
  hint(): string | undefined;
  /** Call from the control's focus handler. */
  focused(): void;
  /** Call from the control's blur handler, after it has normalized its value. */
  blurred(): void;
  /** Return in a single-line control: submits the form around it. Nothing without one. */
  submit(): void;
  /** Whether a form is around the control: Return should submit it, so the input keeps the focus (`submitBehavior="submit"`). */
  readonly inForm: boolean;
  /** `accessibilityLabel`, `accessibilityHint` and `disabled` as getters, to spread on an `Input`: `<Input {...control.props} />`. */
  props: {
    readonly accessibilityLabel: string | undefined;
    readonly accessibilityHint: string | undefined;
    readonly disabled: boolean;
  };
}

/**
 * Makes the calling control a part of its field. Call it once, in the control's body, under the `FieldRoot` (or `Labeled`)
 * it belongs to; with none above it the control gets a field of its own, so every control works alone too. The value is
 * followed through `options.value`: no handler has to report a change.
 */
export function useFieldControl(options: ControlOptions): FieldControl {
  const form = FormScope();
  // Alone in a form it still takes part: its value is in the form's values and a required one stops the submit.
  const field = FieldScope() ?? createField({ form });
  const fieldset = FieldsetScope();
  const item = ItemScope();
  const disabled = () => field.disabled() || !!options.disabled?.() || !!fieldset?.disabled() || !!item?.disabled();
  cleanup(
    field.attach({
      value: options.value,
      empty: options.empty,
      required: options.required,
      violations: options.violations,
      focus: options.focus,
      name: options.name,
    }),
  );
  let first = true;
  effect(() => {
    const value = options.value();
    // The value it started with is the baseline, not a change.
    if (first) {
      first = false;
      return;
    }
    untracked(() => field.valueChanged(value));
  });
  effect(() => {
    if (disabled()) field.setFocused(false);
  });
  const label = () => item?.label.text() || field.label.text() || undefined;
  const hint = () => field.errors().join(" ") || field.description.text() || undefined;
  return {
    field,
    name: field.name,
    disabled,
    invalid: () => field.valid() === false,
    label,
    hint,
    focused: () => field.setFocused(true),
    blurred: () => field.blurred(),
    submit: () => void form?.submit(),
    inForm: form !== undefined,
    props: {
      get accessibilityLabel() {
        return label();
      },
      get accessibilityHint() {
        return hint();
      },
      get disabled() {
        return disabled();
      },
    },
  };
}
