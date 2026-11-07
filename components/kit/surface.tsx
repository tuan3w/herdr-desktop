import { type JSX, Text, View } from "nsh";

import { NUM } from "./core";
import { Icon, type IconName } from "./icon";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** Tints are lighter in dark appearance: the status text is bright there, and a strong tint under it loses contrast (`theme.test.ts`). */
const PILL: Record<Tone, string> = {
  neutral: "bg-muted",
  success: "bg-success/15 dark:bg-success/10",
  warning: "bg-warning/20 dark:bg-warning/12",
  danger: "bg-destructive/15 dark:bg-destructive/10",
  info: "bg-info/15 dark:bg-info/10",
};
const PILL_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-info",
};

/** A status tag: a word or a date, tinted by tone, in a small rounded rectangle. Not pressable. */
export function Pill(props: { text: string; tone?: Tone }) {
  return (
    <View class={`self-start rounded px-2 py-px ${PILL[props.tone ?? "neutral"]}`}>
      <Text style={NUM} class={`text-xs ${PILL_TEXT[props.tone ?? "neutral"]}`}>
        {props.text}
      </Text>
    </View>
  );
}

/** Title block of a screen: `title`, optional `subtitle`, optional `right` (the screen's one action). */
export function PageHeader(props: { title: string; subtitle?: string; right?: JSX.Element }) {
  return (
    <View class="flex-row items-start justify-between gap-4">
      <View class="min-w-0 flex-1 gap-1">
        <Text role="header" class="text-3xl font-bold tracking-tight text-foreground">
          {props.title}
        </Text>
        <If when={props.subtitle}>
          <Text style={NUM} class="text-sm text-muted-foreground">
            {props.subtitle}
          </Text>
        </If>
      </View>
      {props.right}
    </View>
  );
}

/**
 * The heading of a section of a page, with an optional `right` slot: `text-sm font-medium` in the text color.
 * `quiet` is the small grey label of a group inside a section (the task groups of a checklist).
 */
export function SectionTitle(props: { text: string; quiet?: boolean; right?: JSX.Element }) {
  return (
    <View class="flex-row items-center justify-between">
      <Text
        role="header"
        class={props.quiet ? "text-xs font-medium text-muted-foreground" : "text-sm font-medium text-foreground"}
      >
        {props.text}
      </Text>
      {props.right}
    </View>
  );
}

/**
 * Nothing here yet. Title, an optional one-line hint, and children (the action that creates the missing thing).
 * `fill` centers it in the free space of a pane; without it the block sits inside a list or card.
 */
export function Empty(props: {
  title: string;
  hint?: string;
  icon?: IconName;
  fill?: boolean;
  children?: JSX.Element;
}) {
  return (
    <View class={`items-center gap-2 px-6 ${props.fill ? "flex-1 justify-center py-12" : "py-12"}`}>
      <If when={props.icon}>
        {(name) => (
          <View class="mb-1 size-10 items-center justify-center rounded-full bg-muted">
            <Icon name={name()} size={20} tone="muted-foreground" />
          </View>
        )}
      </If>
      <Text class="text-base font-medium text-foreground" style={{ userSelect: "text" }}>
        {props.title}
      </Text>
      <If when={props.hint}>
        <Text class="max-w-sm text-center text-sm text-muted-foreground" style={{ userSelect: "text" }}>
          {props.hint}
        </Text>
      </If>
      {props.children}
    </View>
  );
}
