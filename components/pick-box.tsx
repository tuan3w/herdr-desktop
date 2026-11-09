import { cleanup, effect, keymap, signal, View } from "nsh";

import type { BoardRow } from "herdr-desktop/native";

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
 * Space picks the focused agent for a bulk action and Shift+Space picks the range from the last pick, the keyboard form
 * of the checkbox. The keys are bound only while this row has the focus (a held binding is released with the row), and
 * they read the row at the moment of the press, because a recycled cell shows other agents over time. `order` is the
 * keys of every row in the order they are shown.
 */
export function useRowKeys(row: () => BoardRow, order: () => readonly string[]) {
  const focus = signal(false);
  effect(() => {
    if (!focus()) return;
    return keymap.bind({
      space: () => toggle(row().key),
      "shift+space": () => rangeTo(row().key, order()),
    });
  });
  return { onFocus: () => focus.set(true), onBlur: () => focus.set(false) };
}

/**
 * The place of a Board row's glyph while the row is looked at: the box that picks the agent for a bulk action covers the
 * glyph when the pointer is on this slot or the focus is anywhere in the row, and on every row once anything is picked (so
 * a range can be built without hunting). It sits over the row's left padding, centred on its 12-pt glyph column, so a row
 * spends no width on a column of boxes that is empty most of the time. The row is the `group/row` that holds it. (The
 * sidebar puts its box at the row's right end, beside the `...`: its glyph is there.)
 */
export function PickSlot(props: { rowKey: string; name: string; order: () => readonly string[] }) {
  return (
    <View class="group/pick absolute inset-y-0 left-1 w-7 justify-center">
      <View
        class={`rounded-md bg-background ${selected().length > 0 ? "" : "opacity-0 group-hover/pick:opacity-100 group-focus-within/row:opacity-100"}`}
      >
        <PickBox rowKey={props.rowKey} name={props.name} order={props.order} />
      </View>
    </View>
  );
}
