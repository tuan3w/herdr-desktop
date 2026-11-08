import { announce, cleanup, createMotion, effect, type JSX, keymap, untracked, View, type ViewRef } from "nsh";

import { DURATION, EASE_OUT, hoverTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";

import { FOCUS_RING, releaseFocus, touchedJustNow } from "./core";
import { FieldScope, type FieldControl, useFieldControl } from "./field";
import { Icon } from "./icon";

/** The tick: pops in from 0.4 scale and opacity 0 each time it mounts. `createMotion` lands without moving under reduced motion. */
function CheckMark() {
  const pop = createMotion({
    initial: { scale: 0.4, opacity: 0 },
    enter: { keyframes: { scale: [0.4, 1], opacity: [0, 1] }, duration: DURATION.pop, easing: EASE_OUT },
  });
  return (
    <View style={pop.style}>
      <Icon name="check" size={12} tone="primary-foreground" />
    </View>
  );
}

/** What a screen reader hears after the name: nsh has no accessibility state for these, so they ride the hint. */
export function stateHint(props: { required?: boolean; invalid?: boolean; readOnly?: boolean }): string | undefined {
  const parts = [props.required && "required", props.invalid && "invalid", props.readOnly && "read only"].filter(
    Boolean,
  );
  return parts.length ? parts.join(", ") : undefined;
}

/** The state words, then what the field says (its error or description), as one hint: `required. Tick this to continue.` */
export function spoken(
  state: { required?: boolean; invalid?: boolean; readOnly?: boolean },
  extra: string | undefined,
): string | undefined {
  return [stateHint(state), extra].filter(Boolean).join(". ") || undefined;
}

/**
 * Makes a control that is chosen, not typed (a checkbox, a switch, a radio group) a part of its field and form, as the
 * inputs are: `required` is a rule (an unticked required box stops a `Form` and says why), `name` is where its value goes,
 * the field's error is in its hint. Such a control cannot take focus from code, so a form announces what is wrong
 * instead of moving to it.
 */
export function useChoiceControl(
  props: {
    name?: string;
    label?: string;
    required?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    readOnly?: boolean;
  },
  value: () => unknown,
  empty: (value: unknown) => boolean,
  /** What a required one says while it is empty: the default "Enter a value." is for text. */
  missing: string,
): FieldControl & { wrong: () => boolean; hint: () => string | undefined } {
  const control = useFieldControl({
    value,
    empty,
    required: () => props.required,
    violations: (v) => (props.required && empty(v) ? [{ key: "valueMissing" as const, message: missing }] : []),
    name: () => props.name,
    disabled: () => props.disabled,
  });
  // Under a `FieldRoot` the field announces its own message; a control alone in a form has none, and it cannot take the
  // focus, so a refused submit would be silent.
  if (FieldScope() === undefined) {
    effect(() => {
      const message = control.field.errors().join(" ");
      if (!message) return;
      const name = untracked(() => props.label ?? control.label());
      announce(name ? `${name}: ${message}` : message);
    });
  }
  const wrong = () => !!props.invalid || control.invalid();
  return {
    ...control,
    wrong,
    hint: () => spoken({ required: props.required, invalid: wrong(), readOnly: props.readOnly }, control.hint()),
  };
}

/**
 * A checkbox whose label is part of the target: press the box or the text. `label` is what a screen reader says;
 * `children` is what is drawn next to the box (none: a bare box, e.g. a "select all" in a header).
 * - `indeterminate` is neither: a dash, "mixed" to a screen reader, and a press asks for checked.
 * - Space toggles; Return does not (a checkbox is not a button).
 * - `readOnly` keeps it focusable and unchanged; `disabled` takes it out of Tab; `required` and `invalid` are spoken, and
 *   `invalid` reddens the box.
 * The box is 16 with a 4-pt radius, the row at least 28 tall (44 under Large hit targets) so the target stays the pointer minimum
 * while the mark stays small (emil-ui-polish 8); the label sits 8 from the box. Keep other pressables (delete) outside it. Select-all over a partial selection: `createCheckGroup`.
 */
export function CheckRow(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What a screen reader says. Left out, the text child is used, else the label of the field or item around it. */
  label?: string;
  indeterminate?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** Must be ticked: in a `Form`, an unticked box stops the submit and says `Tick this ...`. */
  required?: boolean;
  invalid?: boolean;
  /** What it is called in a form's values. */
  name?: string;
  class?: string;
  children?: JSX.Element;
}) {
  // A held binding makes the platform consume Return before the pressable sees it. Bound only while this row has the
  // focus, and released with the row, so a removed row cannot leave Return dead.
  let holdReturn: (() => void) | undefined;
  let face: ViewRef | undefined;
  cleanup(() => holdReturn?.());
  const control = useChoiceControl(
    props,
    () => props.checked,
    (v) => v !== true,
    "Tick this box to continue.",
  );
  const name = () =>
    props.label ?? (typeof props.children === "string" ? props.children : undefined) ?? control.label() ?? undefined;
  return (
    <View
      role="checkbox"
      accessibilityLabel={name()}
      accessibilityHint={control.hint()}
      accessibilityState={{ checked: props.indeterminate ? "mixed" : props.checked, disabled: control.disabled() }}
      disabled={control.disabled()}
      ref={(node: ViewRef) => {
        face = node;
      }}
      onPress={() => {
        releaseFocus(face, touchedJustNow());
        if (!props.readOnly) props.onChange(props.indeterminate || !props.checked);
      }}
      onFocus={() => {
        holdReturn ??= keymap.bind("enter", () => {});
        control.focused();
      }}
      onBlur={() => {
        control.blurred();
        holdReturn?.();
        holdReturn = undefined;
      }}
      style={hoverTransition()}
      class={`group flex-row items-center gap-2 rounded-md ${largeTargets() ? "min-h-11" : "min-h-7"} active:opacity-80 disabled:opacity-50 ${FOCUS_RING} ${props.class ?? ""}`}
    >
      <View
        class={`size-4 items-center justify-center rounded-sm border bg-card group-checked:border-primary group-checked:bg-primary group-indeterminate:border-primary group-indeterminate:bg-primary ${control.wrong() ? "border-destructive" : "border-input"}`}
      >
        <If
          when={props.indeterminate}
          else={
            <If when={props.checked}>
              <CheckMark />
            </If>
          }
        >
          <View class="h-0.5 w-2 rounded-full bg-primary-foreground" />
        </If>
      </View>
      {props.children}
    </View>
  );
}
