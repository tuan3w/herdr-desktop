import { announce, effect, signal, untracked } from "nsh";
import type { FormApi, FormMember, ValidationMode } from "./field";

/** Messages by field name, from the owner: a server's answer, a rule over several fields. */
export type FormErrors = Record<string, string | string[]>;

export interface FormOptions {
  /** When fields validate unless they say otherwise. Default `onSubmit`: at the first submit, and on every change after it. */
  validationMode?: () => ValidationMode | undefined;
  /** Messages by field name. A field's message goes when that field changes; a new object replaces them all. */
  errors?: () => FormErrors | undefined;
  /** The form is valid and submitted: the values of its enabled, named fields. */
  onFormSubmit?: (values: Record<string, unknown>) => void;
}

export interface FormController {
  /** What `FormScope` carries to the fields. */
  api: FormApi;
  /**
   * Validates every enabled field and, if one is wrong, stops and moves to the first wrong *input* (`focus()`); a wrong
   * control that is not an input cannot be focused from code, so its message is announced instead and the user reaches it
   * with Tab. Async rules do not hold a submit back. Otherwise calls `onFormSubmit`. Returns whether it submitted.
   */
  submit(): boolean;
  /** Validates every field, or the one named, without submitting. */
  validate(name?: string): Promise<void>;
  values(): Record<string, unknown>;
}

const NONE: FormErrors = {};
const has = (errors: FormErrors, name: string) => Object.prototype.hasOwnProperty.call(errors, name);

/**
 * The state of one form (Base UI's `Form`): the fields that registered, the owner's errors by name, how often a submit was
 * tried. Create it in a component body (it follows `options.errors` with an effect).
 */
export function createForm(options: FormOptions = {}): FormController {
  const members: FormMember[] = [];
  const errors = signal<FormErrors>(options.errors?.() ?? NONE);
  const submits = signal(0);
  let submitted = false;

  const active = () => members.filter((m) => !m.disabled());
  const values = () => {
    const out: Record<string, unknown> = {};
    for (const m of active()) {
      const name = m.name();
      if (name) out[name] = m.value();
    }
    return out;
  };

  // The first wrong input, in the order the fields were made (the order of the form); with none, the first wrong control.
  const focusFirstInvalid = (before?: Map<FormMember, string>): boolean => {
    const wrong = active().filter((m) => m.valid() === false);
    if (wrong.length === 0) return false;
    const target = wrong.find((m) => m.focus) ?? wrong[0] as FormMember;
    target.focus?.();
    // A field announces its message when it appears; one that stayed wrong across this submit says nothing new.
    if (before && before.get(target) === target.summary()) announce(target.summary());
    return true;
  };

  const submit = (): boolean => {
    submits.set(untracked(submits) + 1);
    const fields = active();
    const before = new Map(fields.map((m) => [m, m.summary()] as const));
    // Each field's own check runs up to its first await here: a sync rule has published by the time this returns.
    for (const m of fields) void m.validate();
    if (focusFirstInvalid(before)) return false;
    submitted = true;
    options.onFormSubmit?.(values());
    return true;
  };

  const api: FormApi = {
    mode: () => options.validationMode?.() ?? "onSubmit",
    submitCount: () => submits(),
    errorsFor(name) {
      if (!name) return [];
      const current = errors();
      return has(current, name) ? ([] as string[]).concat(current[name] ?? []).filter(Boolean) : [];
    },
    clearError(name) {
      if (!name || !has(untracked(errors), name)) return;
      const next = { ...untracked(errors) };
      delete next[name];
      errors.set(next);
    },
    values,
    submit,
    register(member) {
      members.push(member);
      return () => {
        const at = members.indexOf(member);
        if (at !== -1) members.splice(at, 1);
      };
    },
  };

  // New errors from the owner after a submit: the server said no, so go to the first field it names.
  let first = true;
  effect(() => {
    const next = options.errors?.() ?? NONE;
    if (first) {
      first = false;
      return;
    }
    untracked(() => {
      errors.set(next);
      if (submitted) {
        submitted = false;
        focusFirstInvalid();
      }
    });
  });

  return {
    api,
    submit,
    async validate(name) {
      await Promise.all(active().filter((m) => !name || m.name() === name).map((m) => m.validate()));
    },
    values,
  };
}
