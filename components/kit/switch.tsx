import { View, type ViewRef } from "nsh";

import { moveTransition, trackTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";

import { useChoiceControl } from "./check";
import { FOCUS_RING, releaseFocus, touchedJustNow } from "./core";

/**
 * An on/off control that takes effect at once (a setting). `label` is what a screen reader says it turns on; the
 * visible label belongs to the row that holds it (`SettingRow`). Space and Return both toggle (a switch is a button
 * that stays down). `readOnly` keeps it focusable and unchanged, `disabled` takes it out of Tab, `required` and
 * `invalid` are spoken.
 *
 * Why the numbers (emil-touch-and-accessibility 2, emil-ui-polish 8): the track is 30 x 18 and the knob 14, small for the
 * eye, but the pressable around it is padded to the pointer hit target (28 tall, `HIT` in `lib/layout.ts`; 44 under
 * Large hit targets), so the small look does not make a small target. The off track is `muted-foreground` at 85% in
 * light (3.99:1 against the card) and 65% in dark (3.56:1 against the card, 3.33:1 against the popover): a control's edge
 * must reach 3:1 without color (emil-forms-and-inputs 4). Measured with the alpha composited in gamma-encoded sRGB, as the
 * toolkit does (linear light would flatter it: 45% in dark is 3.6:1 that way and 2.36:1 for real; the old 40% tint was
 * about 1.6:1). `dark:group-checked:bg-primary` stays: `dark:` ranks last in the engine, so without it the dark off
 * track would win over the checked fill. On is the primary fill AND the knob at the other end:
 * state is position and role, not color alone. The knob slides on `transform` and the track changes colour with it, same
 * 160 ms and curve (`moveTransition`, `trackTransition`), none under reduced motion. The ring floats around the padded target (`FOCUS_RING`).
 */
export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** What it is called in a form's values. */
  name?: string;
}) {
  const control = useChoiceControl(
    props,
    () => props.checked,
    (v) => v !== true,
    "Turn this on to continue.",
  );
  // (target height - 18) / 2: 5 gives 28, 13 gives 44.
  const pad = () => (largeTargets() ? 13 : 5);
  let face: ViewRef | undefined;
  return (
    <View
      role="switch"
      accessibilityLabel={props.label}
      accessibilityHint={control.hint()}
      accessibilityState={{ checked: props.checked, disabled: control.disabled() }}
      disabled={control.disabled()}
      onFocus={control.focused}
      onBlur={control.blurred}
      ref={(node: ViewRef) => {
        face = node;
      }}
      onPress={() => {
        releaseFocus(face, touchedJustNow());
        if (!props.readOnly) props.onChange(!props.checked);
      }}
      style={{ paddingTop: pad(), paddingBottom: pad() }}
      class={`group self-start rounded-md active:opacity-80 ${FOCUS_RING}`}
    >
      <View
        style={trackTransition()}
        class={`h-4.5 w-7.5 justify-center rounded-full border bg-muted-foreground/85 p-px group-checked:bg-primary dark:bg-muted-foreground/65 dark:group-checked:bg-primary group-disabled:opacity-50 ${control.wrong() ? "border-destructive" : "border-transparent"}`}
      >
        <View style={moveTransition()} class="size-3.5 rounded-full bg-card shadow-sm group-checked:translate-x-3" />
      </View>
    </View>
  );
}
