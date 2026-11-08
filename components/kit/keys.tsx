import { Text, View } from "nsh";

import { keycaps } from "#lib/keycaps";

import { NUM } from "./core";

/** `muted` beside a label, `quiet` in a list of rows (hairline, no fill: a column of them is not a wall of boxes), the rest sit on a coloured surface. */
export type KeysTone = "muted" | "quiet" | "bare" | "onPrimary" | "sidebar" | "tip";

const CAP: Record<KeysTone, string> = {
  muted: "border-border bg-muted",
  quiet: "border-border",
  bare: "",
  onPrimary: "border-primary-foreground/30",
  sidebar: "border-sidebar-border",
  tip: "border-background/20 bg-background/15",
};
const TEXT: Record<KeysTone, string> = {
  muted: "text-muted-foreground",
  quiet: "text-muted-foreground",
  bare: "text-muted-foreground",
  onPrimary: "text-primary-foreground opacity-80",
  sidebar: "text-sidebar-accent-foreground opacity-70",
  tip: "text-background opacity-80",
};

/**
 * A shortcut as one cap per key (`⌘` `⇧` `P`), all 20 pt high, a glyph exactly square and a word as wide as its text, 4 pt
 * apart. The group never shrinks or wraps, so the caller right-aligns it at the row's own padding and every row's caps end
 * on the same edge. Decorative: the control's label already says what it does and the caller names the shortcut.
 */
export function Keys(props: { keys: string; tone?: KeysTone }) {
  const tone = () => props.tone ?? "muted";
  // `bare`: plain muted text with no cap (a menu, where a column of boxes is a wall); the group still ends on one edge.
  if (tone() === "bare")
    return (
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={NUM}
        class="shrink-0 text-xs text-muted-foreground"
      >
        {keycaps(props.keys).join(" ")}
      </Text>
    );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      class="shrink-0 flex-row items-center gap-1"
    >
      <Each of={keycaps(props.keys)} key="index">
        {(cap) => (
          <View class={`h-5 min-w-5 items-center justify-center rounded-[5px] border px-1 ${CAP[tone()]}`}>
            <Text style={NUM} class={`text-xs font-medium ${TEXT[tone()]}`}>
              {cap()}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}
