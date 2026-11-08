import { Text, View } from "nsh";

import { hoverTransition } from "#lib/motion";

import { FOCUS_RING_INSET, NUM } from "./core";
import { Clipped } from "./hint";
import { Icon } from "./icon";

/** A count as a person reads it: digits grouped by thousands (`10,000`), never `99+`: a heading's count is a fact, not a badge. */
export function countText(n: number): string {
  const whole = Math.max(0, Math.trunc(n));
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What a heading says to a screen reader: its title and how many rows it holds, `src, 1 file`. */
export function groupLabel(title: string, count: number, noun: readonly [string, string]): string {
  return `${title}, ${countText(count)} ${count === 1 ? noun[0] : noun[1]}`;
}

/** Whether a heading folds: only with something under it and an owner to fold it. A chevron that opens nothing says nothing. */
export const foldable = (count: number, onToggle: unknown) => count > 0 && typeof onToggle === "function";

const TONE = {
  muted: "text-muted-foreground",
  strong: "text-foreground",
  warning: "text-warning",
} as const;

/**
 * The heading of a group of rows in a list (a folder of the changed files, a section of a list): a chevron that turns, the
 * title on one line (a long path ends in an ellipsis and the tip has all of it), and the count at the right edge in tabular
 * figures, grouped by thousands. One line of `text-xs` medium, 28 pt at least (it grows with large text), one fill on
 * hover and the inset ring for the keyboard. It folds only when it holds rows and has `onToggle`; otherwise it is a plain
 * header with no chevron. `indent` is a nested group (24 pt in). The fill is the page's, so in a list with sticky headers
 * the rows scroll under it unseen. It holds no state, so a recycled cell can draw it; the chevron turns without easing for
 * the same reason (a recycled cell would spin).
 */
export function GroupHeading(props: {
  title: string;
  count: number;
  open?: boolean;
  onToggle?: () => void;
  tone?: keyof typeof TONE;
  indent?: boolean;
  /** What the count counts, singular and plural, for the spoken name (`["file", "files"]`, the default `["item", "items"]`). */
  noun?: readonly [string, string];
}) {
  const folds = () => foldable(props.count, props.onToggle);
  return (
    <View
      role={folds() ? "button" : "header"}
      onPress={folds() ? () => props.onToggle?.() : undefined}
      accessibilityLabel={groupLabel(props.title, props.count, props.noun ?? ["item", "items"])}
      accessibilityState={folds() ? { expanded: props.open === true } : undefined}
      style={hoverTransition()}
      class={`min-h-7 w-full flex-row items-center gap-2 rounded-md bg-background px-3 ${folds() ? `hover:bg-accent ${FOCUS_RING_INSET}` : ""} ${props.indent ? "pl-6" : ""}`}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        class={`size-3 shrink-0 items-center justify-center ${folds() && props.open ? "rotate-90" : ""}`}
      >
        <If when={folds()}>
          <Icon name="chevron-right" size={12} tone="muted-foreground" />
        </If>
      </View>
      <View class="min-w-0 flex-1" accessibilityElementsHidden>
        <Clipped class={`text-xs font-medium ${TONE[props.tone ?? "muted"]}`}>{props.title}</Clipped>
      </View>
      <Text style={NUM} class="shrink-0 text-xs text-muted-foreground" accessibilityElementsHidden>
        {countText(props.count)}
      </Text>
    </View>
  );
}
