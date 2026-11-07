import { cleanup, createMotion, type JSX, keymap, View } from "nsh";
import { DURATION, EASE_OUT, hoverTransition } from "../../lib/motion";
import { FOCUS_RING } from "./core";
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
  const parts = [props.required && "required", props.invalid && "invalid", props.readOnly && "read only"].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * A checkbox whose label is part of the target: press the box or the text. `label` is what a screen reader says;
 * `children` is what is drawn next to the box (none: a bare box, e.g. a "select all" in a header).
 * - `indeterminate` is neither: a dash, "mixed" to a screen reader, and a press asks for checked.
 * - Space toggles; Return does not (a checkbox is not a button).
 * - `readOnly` keeps it focusable and unchanged; `disabled` takes it out of Tab; `required` and `invalid` are spoken, and
 *   `invalid` reddens the box.
 * Keep other pressables (delete) outside it. Select-all over a partial selection: `createCheckGroup`.
 */
export function CheckRow(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  indeterminate?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  class?: string;
  children?: JSX.Element;
}) {
  // A held binding makes the platform consume Return before the pressable sees it. Bound only while this row has the
  // focus, and released with the row, so a removed row cannot leave Return dead.
  let holdReturn: (() => void) | undefined;
  cleanup(() => holdReturn?.());
  return (
    <View
      role="checkbox"
      accessibilityLabel={props.label}
      accessibilityHint={stateHint(props)}
      accessibilityState={{ checked: props.indeterminate ? "mixed" : props.checked, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => {
        if (!props.readOnly) props.onChange(props.indeterminate || !props.checked);
      }}
      onFocus={() => {
        holdReturn ??= keymap.bind("enter", () => {});
      }}
      onBlur={() => {
        holdReturn?.();
        holdReturn = undefined;
      }}
      style={hoverTransition()}
      class={`group flex-row items-center gap-3 rounded-md disabled:opacity-50 ${FOCUS_RING} ${props.class ?? ""}`}
    >
      <View
        class={`size-5 items-center justify-center rounded border bg-card group-checked:border-primary group-checked:bg-primary group-indeterminate:border-primary group-indeterminate:bg-primary ${props.invalid ? "border-destructive" : "border-input"}`}
      >
        <If when={props.indeterminate} else={<If when={props.checked}><CheckMark /></If>}>
          <View class="h-0.5 w-2.5 rounded-full bg-primary-foreground" />
        </If>
      </View>
      {props.children}
    </View>
  );
}
