import { announce, effect, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { ViewRef } from "nsh";

import { hoverTransition, pressFeedback, pressTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";

import { FOCUS_RING, FOCUS_RING_SIDEBAR } from "./core";
import { Tipped } from "./hint";
import { Icon, type IconName, type IconTone } from "./icon";
import { Keys } from "./keys";
import { Spinner } from "./loading";
import { useTriggerFocus } from "./tooltip";

export type Variant = "primary" | "outline" | "ghost" | "danger";

const BTN: Record<Variant, string> = {
  primary: "bg-primary active:bg-primary/80 hover:bg-primary/90",
  outline: "border border-input bg-card hover:bg-accent active:bg-accent",
  ghost: "hover:bg-accent active:bg-accent",
  danger: "border border-input hover:bg-destructive/10 active:bg-destructive/20",
};
const BTN_TEXT: Record<Variant, string> = {
  primary: "text-primary-foreground",
  outline: "text-foreground",
  ghost: "text-foreground",
  danger: "text-destructive",
};
const BTN_ICON: Record<Variant, IconTone> = {
  primary: "primary-foreground",
  outline: "foreground",
  ghost: "foreground",
  danger: "destructive",
};

/**
 * A button with a text label. Default 32pt (a dialog or form action; 36 was a phone size); `small` is the dense-row size (28pt, the
 * pointer hit target) and does not depress; Large hit targets makes both 44; `still` opts a
 * default-size button out of the press scale. `hint` shows the shortcut in a keycap after the label.
 */
export function Btn(props: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  small?: boolean;
  disabled?: boolean;
  icon?: IconName;
  hint?: string;
  still?: boolean;
  /**
   * Work is running: the icon becomes a spinner, presses are ignored and the name says "busy", but the button keeps its
   * variant, its width and the keyboard focus (`disabled` would drop it from Tab and strand a focused Save).
   */
  loading?: boolean;
  /** The accessible name when the label alone is ambiguous (the same "Xong" on every row): it must contain `label`. */
  name?: string;
  /** Hands out the button's node, so a screen can move the keyboard focus to it (`setAccessibilityFocus`). */
  buttonRef?: (node: ViewRef) => void;
}) {
  const variant = () => props.variant ?? "outline";
  const press = props.small || props.still ? undefined : pressFeedback();
  const busy = () => props.loading === true;
  // A busy button keeps the focus, so the screen reader is told when it turns busy (its label alone is read on arrival).
  let wasBusy = false;
  effect(() => {
    const now = busy();
    if (now && !wasBusy) announce(`${props.name ?? props.label}, busy`);
    wasBusy = now;
  });
  return (
    <Button
      ref={props.buttonRef}
      onPress={() => {
        if (!busy()) props.onPress();
      }}
      onPressDown={press ? () => !busy() && press.down() : undefined}
      onPressUp={press?.up}
      disabled={props.disabled}
      accessibilityLabel={busy() ? `${props.name ?? props.label}, busy` : props.name}
      style={[pressTransition(), press?.style]}
      class={`flex-row items-center justify-center gap-2 rounded-md ${FOCUS_RING} ${largeTargets() ? "min-h-11" : props.small ? "min-h-7" : "min-h-8"} ${props.small ? "px-3" : "px-4"} ${
        props.disabled ? "border-transparent bg-muted" : BTN[variant()]
      }`}
    >
      <If when={props.loading}>
        <Spinner size={props.small ? 14 : 16} tone={BTN_ICON[variant()]} />
      </If>
      <If when={props.loading ? undefined : props.icon}>
        {(name) => (
          <Icon
            name={name()}
            size={props.small ? 14 : 16}
            tone={props.disabled ? "muted-foreground" : BTN_ICON[variant()]}
          />
        )}
      </If>
      <Text
        class={`font-medium ${props.small ? "text-xs" : "text-sm"} ${props.disabled ? "text-muted-foreground" : BTN_TEXT[variant()]}`}
      >
        {props.label}
      </Text>
      <If when={props.hint && !props.disabled}>
        <Keys keys={props.hint!} tone={variant() === "primary" ? "onPrimary" : "muted"} />
      </If>
    </Button>
  );
}

/**
 * A button with an icon and no visible text. `label` is required: it is what a screen reader says and what the
 * tooltip shows. 28pt box (44 under Large hit targets), grey; `onSidebar` for the sidebar surface. It is a `View` that
 * takes presses, not nsh's `Button`: only a view reports the keyboard focus, and the tooltip (label and shortcut) must
 * show to a keyboard user who Tabs onto the button as it does to the pointer.
 */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  onSidebar?: boolean;
  /** A toggled button, such as the trigger of an open menu: filled while on, and screen readers say so. */
  selected?: boolean;
  shortcut?: string;
  /** Not available now (a plus for an offline project): still named and shown, muted, no press, not a stop of Tab. The tooltip stays, so the name says what is missing. */
  disabled?: boolean;
  /** A 32-pt box with a 16-pt icon (44 under Large hit targets), for a sidebar line's actions that sit apart. */
  roomy?: boolean;
  /** What the bubble says when it is shorter than `label` (the accessible name keeps the whole). */
  tip?: string;
  /** Where the bubble opens (above for a control on text). */
  tipSide?: "top" | "bottom";
  /** Hands out the button's node, so a screen can return the keyboard focus to it. */
  buttonRef?: (node: ViewRef) => void;
}) {
  return (
    <Tipped label={props.tip ?? props.label} shortcut={props.shortcut} side={props.tipSide}>
      <IconFace
        icon={props.icon}
        label={props.label}
        onPress={props.onPress}
        onSidebar={props.onSidebar}
        selected={props.selected}
        disabled={props.disabled}
        roomy={props.roomy}
        buttonRef={props.buttonRef}
      />
    </Tipped>
  );
}

/** The pressable of an `IconButton`: a component of its own so `useTriggerFocus()` reads the `Tipped` around it. */
function IconFace(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  onSidebar?: boolean;
  selected?: boolean;
  disabled?: boolean;
  roomy?: boolean;
  buttonRef?: (node: ViewRef) => void;
}) {
  const focus = useTriggerFocus();
  const hover = () =>
    props.onSidebar ? "hover:bg-sidebar-accent active:bg-sidebar-accent" : "hover:bg-accent active:bg-accent";
  return (
    <View
      ref={(node: ViewRef) => props.buttonRef?.(node)}
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      onPress={props.disabled ? undefined : props.onPress}
      focusable={props.disabled ? false : undefined}
      {...(props.disabled ? {} : focus)}
      style={hoverTransition()}
      class={`${largeTargets() ? "size-11" : props.roomy ? "size-8" : "size-7"} items-center justify-center rounded-md ${
        props.disabled
          ? "opacity-50"
          : `selected:bg-accent ${hover()} ${props.onSidebar ? FOCUS_RING_SIDEBAR : FOCUS_RING}`
      }`}
    >
      <Icon name={props.icon} tone={props.disabled || !props.onSidebar ? "muted-foreground" : "sidebar-foreground"} />
    </View>
  );
}
