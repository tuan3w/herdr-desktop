import { cleanup, keymap, View } from "nsh";
import { isSelected, rangeTo, toggle } from "../lib/selection";
import { FOCUS_RING, Icon } from "./kit";

/**
 * The box that picks one agent for a bulk action. A press toggles it, a press with Shift picks everything from the
 * last box toggled to this one (`order` is the keys of every row in the order they are shown), Space toggles it from
 * the keyboard. Return does not: it belongs to the row beside it, which opens the agent.
 */
export function PickBox(props: { rowKey: string; name: string; order: () => readonly string[] }) {
  // A held binding makes the platform consume Return before the pressable sees it (as `CheckRow` does): bound only while
  // this box has the focus and released with it.
  let holdReturn: (() => void) | undefined;
  cleanup(() => holdReturn?.());
  const checked = () => isSelected(props.rowKey);
  return (
    <View
      role="checkbox"
      accessibilityLabel={`Select ${props.name}`}
      accessibilityState={{ checked: checked() }}
      onPress={(e) => {
        if (e?.modifiers?.shift) rangeTo(props.rowKey, props.order());
        else toggle(props.rowKey);
      }}
      onFocus={() => {
        holdReturn ??= keymap.bind("enter", () => {});
      }}
      onBlur={() => {
        holdReturn?.();
        holdReturn = undefined;
      }}
      class={`size-7 items-center justify-center rounded-md ${FOCUS_RING}`}
    >
      <View class={`size-5 items-center justify-center rounded border ${checked() ? "border-primary bg-primary" : "border-input bg-card"}`}>
        <If when={checked()}>
          <Icon name="check" size={12} tone="primary-foreground" />
        </If>
      </View>
    </View>
  );
}
