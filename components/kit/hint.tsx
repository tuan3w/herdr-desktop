import { signal, Text, View } from "nsh";

import type { JSX } from "nsh";
import type { TextStyle } from "nsh/types";

import { NUM } from "./core";
import { FocusScope, TipContent, TipText, useTooltip } from "./tooltip";

/** Line breaks and spaces are not text: a wrapped line may drop the space it broke at. */
const letters = (s: string) => s.replace(/\s/g, "").length;

/**
 * Text that is cut with an ellipsis and still says what it cut. When it fits, nothing is different. When it does not,
 * the pointer resting on it shows the whole text in a bubble, as Finder does for a file name; screen readers always
 * hear all of it. `lines` (default 1) is how many lines show before the cut; `label` is the whole text when the
 * children are not one string (nested spans). For what a row can lose: a company name, a route, a preview. What the
 * user must read to act (an error, a page title) gets room instead: wrap it, or widen the column.
 */
export function Clipped(props: {
  lines?: number;
  label?: string;
  /** `false` where a preview card already shows the whole text (a row of the inbox). */ tip?: boolean;
  class?: string;
  style?: TextStyle;
  children?: JSX.Element;
}) {
  const cut = signal(false);
  const full = () => props.label ?? (typeof props.children === "string" ? props.children : "");
  const tip = useTooltip(() => <TipText>{full()}</TipText>, {
    disabled: () => !cut() || props.tip === false,
  });
  return (
    <Text
      ref={tip.ref}
      onMouseEnter={tip.onMouseEnter}
      onMouseLeave={tip.onMouseLeave}
      class={props.class}
      style={[{ numberOfLines: props.lines ?? 1 }, props.style]}
      onTextLayout={(e) => cut.set(letters(e.lines.map((l) => l.text).join("")) < letters(full()))}
    >
      {props.children}
    </Text>
  );
}

/**
 * Shows `label` (plus its `shortcut`) in a bubble after the pointer rests on `children` (`design/overlays.md`). The
 * trigger is this wrapper View, not the control inside it; layout classes for the wrapper go in `class`. Every control
 * without a visible text label needs one. `delay`, `closeDelay`, `disabled` and `closeOnClick` are this trigger's own
 * (`TooltipOptions`). A control built on a `View` with `onPress` inside it shows the bubble to keyboard users too, once it
 * spreads `useTriggerFocus()`.
 */
export function Tipped(props: {
  label: string;
  shortcut?: string;
  delay?: number;
  closeDelay?: number;
  disabled?: boolean;
  closeOnClick?: boolean;
  class?: string;
  children?: JSX.Element;
}) {
  const tip = useTooltip(() => <TipContent label={props.label} shortcut={props.shortcut} />, {
    disabled: () => props.disabled ?? false,
    delay: props.delay,
    closeDelay: props.closeDelay,
    closeOnClick: props.closeOnClick,
  });
  return (
    <View ref={tip.ref} onMouseEnter={tip.onMouseEnter} onMouseLeave={tip.onMouseLeave} class={props.class}>
      <FocusScope.Provider value={tip.focus}>{props.children}</FocusScope.Provider>
    </View>
  );
}

/** A keycap: the shortcut shown beside a label (`⌘N`). Decorative: the control's label already says what it does. */
export function Kbd(props: { keys: string; tone?: "muted" | "onPrimary" | "sidebar" }) {
  const box = () =>
    props.tone === "onPrimary"
      ? "border-primary-foreground/30"
      : props.tone === "sidebar"
        ? "border-sidebar-border"
        : "border-border bg-muted";
  const text = () =>
    props.tone === "onPrimary"
      ? "text-primary-foreground opacity-80"
      : props.tone === "sidebar"
        ? "text-sidebar-accent-foreground opacity-70"
        : "text-muted-foreground";
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      class={`min-w-5 items-center rounded border px-1 py-px ${box()}`}
    >
      <Text style={NUM} class={`text-xs ${text()}`}>
        {props.keys}
      </Text>
    </View>
  );
}
