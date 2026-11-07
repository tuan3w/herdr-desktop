import { View } from "nsh";

import { Swap } from "./swap";

export type BadgeTone = "neutral" | "signal" | "primary" | "danger";

interface Look {
  /** Empty: the count is plain text, no capsule. */
  fill: string;
  ink: string;
  dot: string;
}

const PAGE: Record<BadgeTone, Look> = {
  neutral: { fill: "", ink: "text-muted-foreground", dot: "bg-muted-foreground" },
  signal: { fill: "bg-signal", ink: "text-signal-foreground", dot: "bg-signal" },
  primary: { fill: "bg-primary", ink: "text-primary-foreground", dot: "bg-primary" },
  danger: { fill: "bg-destructive/15 dark:bg-destructive/10", ink: "text-destructive", dot: "bg-destructive" },
};
/** On the sidebar only `sidebar-*` tokens apply: a plain grey count, or the theme's signal. */
const SIDEBAR_NEUTRAL: Look = { fill: "", ink: "text-muted-foreground", dot: "bg-muted-foreground" };
const SIDEBAR_HOT: Look = {
  fill: "bg-sidebar-primary",
  ink: "text-sidebar-primary-foreground",
  dot: "bg-sidebar-primary",
};

/**
 * How many are waiting, on the thing that holds them: a nav item, a tab, a table cell. By default a plain grey number:
 * most counts are information, not a request. Only a count that needs the user (`signal`, `danger`, `primary`)
 * gets a capsule, so the one thing on screen that asks for attention is the one thing that looks like it does.
 * `dot` is "something is there" where the number does not fit (the sidebar rail). Hidden at 0, `99+` above `max`.
 * A count, not a status (a status is a `Pill` with a word). Not read on its own: the holder's accessible name includes it.
 */
export function Badge(props: { count?: number; dot?: boolean; tone?: BadgeTone; max?: number; onSidebar?: boolean }) {
  const tone = () => props.tone ?? "neutral";
  const look = () => (props.onSidebar ? (tone() === "neutral" ? SIDEBAR_NEUTRAL : SIDEBAR_HOT) : PAGE[tone()]);
  const text = () => {
    const max = props.max ?? 99;
    return (props.count ?? 0) > max ? `${max}+` : `${props.count}`;
  };
  return (
    <If when={props.dot || (props.count ?? 0) > 0}>
      <If
        when={props.dot}
        else={
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            class={look().fill ? `min-w-5 items-center rounded-full px-2 py-px ${look().fill}` : "items-center"}
          >
            <Swap text={text()} class={`text-xs ${look().fill ? "font-medium" : ""} ${look().ink}`} />
          </View>
        }
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          class={`size-2 rounded-full ${look().dot}`}
        />
      </If>
    </If>
  );
}
