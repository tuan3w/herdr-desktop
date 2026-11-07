import { stateHint } from "./check";
import { View } from "nsh";
import { hoverTransition, moveTransition } from "../../lib/motion";
import { FOCUS_RING } from "./core";

/**
 * An on/off control that takes effect at once (a setting). `label` is what a screen reader says it turns on; the
 * visible label belongs to the row that holds it (`SettingRow`). Space and Return both toggle (a switch is a button
 * that stays down). `readOnly` keeps it focusable and unchanged, `disabled` takes it out of Tab, `required` and
 * `invalid` are spoken. The thumb slides on `transform`, the track eases color.
 */
export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
}) {
  return (
    <View
      role="switch"
      accessibilityLabel={props.label}
      accessibilityHint={stateHint(props)}
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => {
        if (!props.readOnly) props.onChange(!props.checked);
      }}
      class={`group self-start rounded-full ${FOCUS_RING}`}
    >
      <View
        style={hoverTransition()}
        class={`h-6 w-11 justify-center rounded-full border bg-muted-foreground/40 p-px group-checked:bg-primary group-disabled:opacity-50 ${props.invalid ? "border-destructive" : "border-transparent"}`}
      >
        <View style={moveTransition()} class="size-5 rounded-full bg-card shadow-sm group-checked:translate-x-5" />
      </View>
    </View>
  );
}
