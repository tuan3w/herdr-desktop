import { Text, View } from "nsh";
import { hoverTransition } from "../lib/motion";
import { largeTargets } from "../lib/settings";
import { FOCUS_RING, Icon, Spinner } from "./kit";

/**
 * One answer of an agent's request: a permission option or Accept and Decline of a form. Its name is the agent's own
 * words; armed, it says what pressing again will do and why; refused, it says so on the button that was pressed.
 * The sibling of `answer-dock.tsx`'s chip for terminal prompts, with the same states and the same look.
 */
export function AskChip(props: {
  label: string;
  /** A risky or standing answer: marked with a warning glyph and spoken as needing two presses. */
  risky: boolean;
  /** What pressing again does and why, while the answer is armed. */
  armed?: string;
  /** The answer is being sent. */
  busy: boolean;
  /** What to say instead of the label after a refusal (`The request changed`). */
  refused?: string;
  /** Not pressable for the moment (the guard, a send in flight): dimmed. */
  dim: boolean;
  onPress: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const name = () => {
    if (props.armed) return `${props.label}. Press again to send, ${props.armed}`;
    if (props.refused) return `${props.label}. ${props.refused}`;
    if (props.busy) return `${props.label}, sending`;
    return props.label;
  };
  return (
    <View
      role="button"
      accessibilityLabel={name()}
      accessibilityHint={props.risky && !props.armed ? "Needs a second press" : undefined}
      accessibilityState={{ selected: props.armed !== undefined, busy: props.busy }}
      onPress={props.onPress}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      style={hoverTransition()}
      class={`max-w-full flex-row items-center gap-2 rounded-md border px-3 py-1.5 hover:bg-accent ${largeTargets() ? "min-h-11" : "min-h-8"} ${
        props.dim ? "opacity-50" : ""
      } ${props.armed ? "border-warning bg-warning/20 dark:bg-warning/12" : "border-input bg-card"} ${FOCUS_RING}`}
    >
      <If when={props.risky}>
        <Icon name="alert" size={14} tone="warning" />
      </If>
      <View class="shrink gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.refused ?? props.label}</Text>
        <If when={props.armed}>
          <Text class="text-xs text-foreground">{`Press again to send · ${props.armed}`}</Text>
        </If>
      </View>
      <If when={props.busy}>
        <Spinner size={14} tone="muted-foreground" />
      </If>
    </View>
  );
}
