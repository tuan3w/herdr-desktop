import { announce, cleanup, effect, type JSX, signal, Text, untracked, View } from "nsh";

import { drawsOwnValue, isCutOff } from "./combo-rules";
import {
  createField,
  createTextSlot,
  type Field,
  FieldScope,
  FieldsetScope,
  FormScope,
  ItemScope,
  type ValidationMode,
  type Validator,
  type ValidityKey,
} from "./field";
import { createForm, type FormController, type FormErrors } from "./form";
import { Icon } from "./icon";
import { TipText, useTooltip } from "./tooltip";

/**
 * The parts of a field, Base UI's `Field.Root`, `Label`, `Description`, `Error`, `Validity`, `Item` and `Fieldset`, with
 * `Form`. `Labeled` (fields.tsx) is the props-driven way to put them together; compose them by hand for anything else.
 */

/** What a field takes beyond its own look: the rules and the name it submits under. */
export interface FieldRules {
  /** What the field is called in a form's `values` and `errors`. */
  name?: string;
  disabled?: boolean;
  /** The owner says it is wrong. */
  invalid?: boolean;
  /** The field's own rule: the message(s) when the value is wrong. Async is fine. */
  validate?: Validator;
  /** When it checks: `onBlur`, `onChange`, or `onSubmit` (the form's default). The form's mode is used when this is not set. */
  validationMode?: ValidationMode;
  /** Wait this long after the last change before checking, in `onChange` mode. */
  validationDebounceTime?: number;
}

/**
 * Groups the parts of one field and owns its state (`Field` in field.ts). An error that appears is announced once, as
 * `label: message`, since it appears away from where a screen reader is.
 */
export function FieldRoot(
  props: FieldRules & {
    /** The owner's message for the field: shown before any other, and the field is invalid while it is set. */
    error?: string;
    dirty?: boolean;
    touched?: boolean;
    class?: string;
    children?: JSX.Element;
  },
) {
  const fieldset = FieldsetScope();
  const field = createField({
    name: () => props.name,
    disabled: () => props.disabled || fieldset?.disabled(),
    invalid: () => props.invalid,
    error: () => props.error,
    dirty: () => props.dirty,
    touched: () => props.touched,
    validate: () => props.validate,
    validationMode: () => props.validationMode,
    validationDebounceTime: () => props.validationDebounceTime,
    form: FormScope(),
  });
  effect(() => {
    const message = field.errors().join(" ");
    if (!message) return;
    const label = untracked(() => field.label.text());
    announce(label ? `${label}: ${message}` : message);
  });
  return (
    <FieldScope.Provider value={field}>
      <View class={props.class ?? "min-w-0 flex-1 gap-1"}>{props.children}</View>
    </FieldScope.Provider>
  );
}

/**
 * Names the control: its text is the accessible name of the control in the field (or in the `FieldItem` around it), and
 * pressing it focuses the control when that is an input. With `errorInLabel` the label line says `label: error` while the
 * field is wrong, for a row of bottom-aligned fields where an extra line below would push an input out of line.
 */
export function FieldLabel(props: { children: string; errorInLabel?: boolean; class?: string }) {
  const field = FieldScope();
  const item = ItemScope();
  const slot = item?.label ?? field?.label;
  if (slot) cleanup(slot.add(() => props.children));
  const shown = () => (props.errorInLabel && field?.errors().join(" ")) || "";
  return (
    <If
      when={shown()}
      else={
        <Text
          focusable={false}
          onPress={() => field?.focus()}
          class={props.class ?? "text-xs font-medium text-muted-foreground"}
          classList={{ "opacity-60": !!(item?.disabled() ?? field?.disabled()) }}
        >
          {props.children}
        </Text>
      }
    >
      <View class="flex-row items-start gap-1">
        <AlertMark />
        <Text
          class="line-clamp-1 flex-1 text-xs font-medium text-destructive"
          style={{ userSelect: "text" }}
        >{`${props.children}: ${shown()}`}</Text>
      </View>
    </If>
  );
}

/**
 * The alert icon of an error, in a box one `text-xs` line tall: it sits on the first line of a message that wraps, not
 * halfway down a paragraph (a three-line error drew it beside the second line).
 */
function AlertMark() {
  return (
    <View class="h-4 shrink-0 justify-center">
      <Icon name="alert" size={12} tone="destructive" />
    </View>
  );
}

/** Says what the control is for. A screen reader gets it after the name, while no error shows. */
export function FieldDescription(props: { children: string; class?: string }) {
  const field = FieldScope();
  if (field) cleanup(field.description.add(() => props.children));
  return (
    <Text class={props.class ?? "text-xs text-muted-foreground"} style={{ userSelect: "text" }}>
      {props.children}
    </Text>
  );
}

/**
 * The field's message, under the control: the owner's, else the form's for this name, else that of the rules (a list when
 * there are several). It shows while the field is wrong and not disabled. `match` limits it to one broken constraint
 * (`valueMissing`, `badInput`, ...) so each can have its own `children`; `match` true shows it always, for an external
 * rule. A red edge, the alert icon and the text: colour is never the only signal.
 */
export function FieldError(props: { match?: boolean | ValidityKey; children?: string; class?: string }) {
  const field = FieldScope();
  const shown = (): boolean => {
    if (!field) return false;
    if (props.match === true) return true;
    if (field.disabled()) return false;
    if (typeof props.match === "string") return field.validity().state[props.match];
    return field.errors().length > 0;
  };
  const lines = (): string[] => {
    if (props.children) return [props.children];
    if (!field) return [];
    return typeof props.match === "string" ? field.validity().errors.slice(0, 1) : field.errors();
  };
  return (
    <If when={shown()}>
      <View class="gap-1">
        <Each of={lines()} key="index">
          {(line) => (
            <View class="flex-row items-start gap-1">
              <AlertMark />
              <Text class={props.class ?? "flex-1 text-xs text-destructive"} style={{ userSelect: "text" }}>
                {line()}
              </Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

/** The state of the field as a function of the view: `<FieldValidity>{(field) => <Text>{field.validity().error}</Text>}</FieldValidity>`. */
export function FieldValidity(props: { children: (field: Field) => JSX.Element }) {
  const field = FieldScope();
  return <If when={field}>{(f) => props.children(f())}</If>;
}

/**
 * One item of a group inside a field (a checkbox of a group): it has a label of its own, and can be disabled alone. A
 * `FieldLabel` inside names this item's control, not the field's.
 */
export function FieldItem(props: { disabled?: boolean; class?: string; children?: JSX.Element }) {
  const field = FieldScope();
  const label = createTextSlot();
  return (
    <ItemScope.Provider value={{ disabled: () => !!props.disabled || !!field?.disabled(), label }}>
      <View class={props.class ?? "flex-row items-center gap-2"}>{props.children}</View>
    </ItemScope.Provider>
  );
}

/**
 * Fields that go together: disabling it disables each of them, and its `FieldsetLegend` names the group. It is a
 * `group` named by the legend.
 */
export function Fieldset(props: { disabled?: boolean; class?: string; children?: JSX.Element }) {
  const parent = FieldsetScope();
  const legend = createTextSlot();
  return (
    <FieldsetScope.Provider value={{ disabled: () => !!props.disabled || !!parent?.disabled(), legend }}>
      <View role="group" accessibilityLabel={legend.text() || undefined} class={props.class ?? "gap-3"}>
        {props.children}
      </View>
    </FieldsetScope.Provider>
  );
}

export function FieldsetLegend(props: { children: string; class?: string }) {
  const fieldset = FieldsetScope();
  if (fieldset) cleanup(fieldset.legend.add(() => props.children));
  return (
    <Text role="header" class={props.class ?? "text-sm font-medium text-foreground"}>
      {props.children}
    </Text>
  );
}

/**
 * The fields inside it validate together and submit as one. Give it a `form` (`createForm`) when something outside needs
 * `form.submit()` (a dialog's primary button), or `onFormSubmit` and the rest here and it makes its own. Return in a
 * single-line field submits it.
 */
export function Form(props: {
  form?: FormController;
  validationMode?: ValidationMode;
  errors?: FormErrors;
  onFormSubmit?: (values: Record<string, unknown>) => void;
  class?: string;
  children?: JSX.Element;
}) {
  const form =
    props.form ??
    createForm({
      validationMode: () => props.validationMode,
      errors: () => props.errors,
      onFormSubmit: (values) => props.onFormSubmit?.(values),
    });
  return (
    <FormScope.Provider value={form.api}>
      <View class={props.class ?? "gap-3"}>{props.children}</View>
    </FormScope.Provider>
  );
}

/**
 * Puts the value of a one-line input in one line at rest: a `Text` of one line over the field, ending in an ellipsis, with
 * the whole value in a bubble when the pointer rests on it and cut. The field's own text must be transparent while
 * `OneLine`'s `drawsOwnValue` holds (the caller sets the class), and its accessible name already carries the whole value.
 * `padRight` is the field's right padding (room for its chevron or clear button); `mono` follows the field's font.
 */
export function OneLine(props: {
  text: string;
  focused: boolean;
  padRight: string;
  mono?: boolean;
  /** The field is disabled: the drawn value fades with the box. */
  faded?: boolean;
  children?: JSX.Element;
}) {
  const cut = signal(false);
  const tip = useTooltip(() => <TipText>{props.text}</TipText>, { disabled: () => !cut() || props.focused });
  return (
    <View ref={tip.ref} onMouseEnter={tip.onMouseEnter} onMouseLeave={tip.onMouseLeave} class="relative">
      {props.children}
      <If when={drawsOwnValue({ text: props.text, focused: props.focused })}>
        <View class={`pointer-events-none absolute inset-0 justify-center pl-[13px] ${props.padRight}`}>
          <Text
            style={{ numberOfLines: 1 }}
            class={`min-w-0 text-sm text-foreground ${props.mono ? "font-mono" : ""} ${props.faded ? "opacity-50" : ""}`}
            onTextLayout={(e) =>
              cut.set(
                isCutOff(
                  e.lines.map((l) => l.text),
                  props.text,
                ),
              )
            }
          >
            {props.text}
          </Text>
        </View>
      </If>
    </View>
  );
}
