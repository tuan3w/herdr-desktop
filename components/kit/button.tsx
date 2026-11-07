import { Text, View } from "nsh";
import { Button } from "nsh/base";

import type { ViewRef } from "nsh";

import { hoverTransition, pressFeedback, pressTransition } from "#lib/motion";

import { FOCUS_RING, FOCUS_RING_SIDEBAR } from "./core";
import { Kbd, Tipped } from "./hint";
import { Icon, type IconName, type IconTone } from "./icon";
import { Spinner } from "./loading";

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
 * A button with a text label. Default 32pt; `small` is the dense-row size (28pt) and does not depress; `still` opts a
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
  /** Work is running: the icon becomes a spinner and presses are ignored, but the button keeps its variant and width. */
  loading?: boolean;
  /** The accessible name when the label alone is ambiguous (the same "Xong" on every row): it must contain `label`. */
  name?: string;
  /** Hands out the button's node, so a screen can move the keyboard focus to it (`setAccessibilityFocus`). */
  buttonRef?: (node: ViewRef) => void;
}) {
  const variant = () => props.variant ?? "outline";
  const press = props.small || props.still ? undefined : pressFeedback();
  return (
    <Button
      ref={props.buttonRef}
      onPress={props.onPress}
      onPressDown={press?.down}
      onPressUp={press?.up}
      disabled={props.disabled || props.loading}
      accessibilityLabel={props.loading ? `${props.name ?? props.label}, busy` : props.name}
      style={[pressTransition(), press?.style]}
      class={`flex-row items-center justify-center gap-2 rounded-md ${FOCUS_RING} ${props.small ? "min-h-8 px-3" : "min-h-9 px-4"} ${
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
        <View class="pl-1">
          <Kbd keys={props.hint!} tone={variant() === "primary" ? "onPrimary" : "muted"} />
        </View>
      </If>
    </Button>
  );
}

/**
 * A button with an icon and no visible text. `label` is required: it is what a screen reader says and what the
 * tooltip shows. 28pt box, grey; `onSidebar` for the sidebar surface.
 */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  onSidebar?: boolean;
  /** A toggled button, such as the trigger of an open menu: filled while on, and screen readers say so. */
  selected?: boolean;
  shortcut?: string;
}) {
  const hover = () =>
    props.onSidebar ? "hover:bg-sidebar-accent active:bg-sidebar-accent" : "hover:bg-accent active:bg-accent";
  return (
    <Tipped label={props.label} shortcut={props.shortcut}>
      <Button
        onPress={props.onPress}
        accessibilityLabel={props.label}
        selected={props.selected}
        style={hoverTransition()}
        class={`size-8 items-center justify-center rounded-md selected:bg-accent ${hover()} ${props.onSidebar ? FOCUS_RING_SIDEBAR : FOCUS_RING}`}
      >
        <Icon name={props.icon} tone={props.onSidebar ? "sidebar-foreground" : "muted-foreground"} />
      </Button>
    </Tipped>
  );
}
