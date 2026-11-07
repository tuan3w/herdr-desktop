import { context, type JSX, View } from "nsh";
import { hoverTransition } from "../../lib/motion";
import { stateHint } from "./check";
import { createRoving, type Orientation, RING, type Roving } from "./roving";

interface Scope {
  value: () => string | undefined;
  choose: (value: string) => void;
  disabled: () => boolean;
  roving: Roving;
}

const Group = context<Scope | undefined>(undefined);

/**
 * Exactly one of a few options (Base UI's RadioGroup). The group is one stop of Tab; the arrow keys move to the previous
 * or next item and choose it, wrapping and passing over disabled ones; Space chooses, Return does not. This host
 * cannot move the focus to an item, so the focus stays on the group and the ring moves (`roving.ts`).
 * - Controlled only: `value` and `onChange` (a press on the chosen item reports nothing).
 * - `readOnly`: the arrows still move the ring, nothing is chosen. `disabled` takes the group out of Tab.
 * - `required` and `invalid` are spoken. `label` names the group when its heading is not part of it.
 * Look is the items' `class`. For two to four short labels use `Segmented`.
 */
export function RadioGroup<T extends string>(props: {
  value: T | undefined;
  onChange: (value: T) => void;
  label?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  orientation?: Orientation;
  loop?: boolean;
  class?: string;
  children?: JSX.Element;
}) {
  const roving = createRoving({
    orientation: props.orientation,
    loop: props.loop,
    activateOnMove: () => !props.readOnly,
    activateKeys: ["space"],
  });
  const scope: Scope = {
    value: () => props.value,
    choose: (value) => {
      if (!props.readOnly && !props.disabled && value !== props.value) props.onChange(value as T);
    },
    disabled: () => props.disabled === true,
    roving,
  };
  return (
    <Group.Provider value={scope}>
      <View
        role="radiogroup"
        accessibilityLabel={props.label}
        accessibilityHint={stateHint(props)}
        disabled={props.disabled}
        {...roving.focus}
        class={props.class}
      >
        {props.children}
      </View>
    </Group.Provider>
  );
}

/**
 * One option of a `RadioGroup`. `class` is its look: `checked:` styles the item itself, `group-checked:` its children
 * (the item is a `group`). `label` is the accessible name. The ring is drawn on it while the group has the focus.
 */
export function RadioItem<T extends string>(props: { value: T; label: string; disabled?: boolean; class?: string; children?: JSX.Element }) {
  const scope = Group();
  if (!scope) throw new Error("RadioItem must be inside a RadioGroup");
  const checked = () => scope.value() === props.value;
  const off = () => scope.disabled() || props.disabled === true;
  const mark = scope.roving.add({
    label: () => props.label,
    disabled: off,
    current: checked,
    activate: () => scope.choose(props.value),
  });
  return (
    <View
      role="radio"
      focusable={false}
      accessibilityLabel={props.label}
      accessibilityState={{ checked: checked(), selected: checked(), disabled: off() }}
      disabled={off()}
      onPress={() => scope.choose(props.value)}
      style={hoverTransition()}
      class={`group ${props.class ?? ""} ${mark.ring() ? RING : ""}`}
    >
      {props.children}
    </View>
  );
}
