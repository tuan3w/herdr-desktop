import { cleanup, keymap, View } from "nsh";

import { FOCUS_RING, Icon } from "#kit";
import { isSelected, rangeTo, selected, toggle } from "#lib/selection";

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
      <View
        class={`size-5 items-center justify-center rounded border ${checked() ? "border-primary bg-primary" : "border-input bg-card"}`}
      >
        <If when={checked()}>
          <Icon name="check" size={12} tone="primary-foreground" />
        </If>
      </View>
    </View>
  );
}

/**
 * The place of a row's glyph while the row is looked at: the box that picks the agent for a bulk action covers the glyph
 * when the pointer is on this slot or the focus is anywhere in the row, and on every row once anything is picked (so a
 * range can be built without hunting). It sits over the row's left padding, so a row spends no width on a column of
 * boxes that is empty most of the time. The row is the `group/row` that holds it.
 */
export function PickSlot(props: {
  rowKey: string;
  name: string;
  order: () => readonly string[];
  surface: "sidebar" | "card";
  nested?: boolean;
}) {
  return (
    <View class={`group/pick absolute inset-y-0 w-7 justify-center ${props.nested ? "left-4" : "left-1"}`}>
      <View
        class={`rounded-md ${props.surface === "sidebar" ? "bg-sidebar" : "bg-card"} ${selected().length > 0 ? "" : "opacity-0 group-hover/pick:opacity-100 group-focus-within/row:opacity-100"}`}
      >
        <PickBox rowKey={props.rowKey} name={props.name} order={props.order} />
      </View>
    </View>
  );
}
