import { View } from "nsh";

import { hoverTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";

import { Clipped } from "./hint";
import { Icon, type IconName } from "./icon";
import { RadioGroup, RadioItem } from "./radio-group";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

/**
 * Pick exactly one of two to four short options that change the view of the same thing (Light / Dark). More options or
 * long labels use `SelectField`. A `RadioGroup`: one stop of Tab, arrows choose, screen readers hear one set, each
 * option a radio. `iconOnly` drops the text (every option needs an `icon`; the label stays as its accessible name): for a
 * toolbar toggle between two views (list / table), where the icons are universal.
 *
 * Why it looks like this:
 * - Recessed track (`bg-muted`), raised chosen segment: `bg-card` and the ring of `shadow-sm` (no border in light). The fill
 *   alone is 1.11:1 against the track; the 0.08 ring of `shadow-sm` edges it at about 1.3:1 against the fill (3:1 would
 *   need a heavy border, and a border beside the ring draws the edge twice). In dark a shadow cannot be seen (emil-surfaces
 *   3), so the shadow is off and the segment has a single 40% `foreground` border (3.21:1, past the 3:1 a control's edge
 *   needs) on the plain `bg-card` fill: a border or a fill, never both with a ring.
 *   Ratios are composited in gamma sRGB over the track, as the toolkit does.
 * - Nested radii: track `rounded-md` (8), segment `rounded-base` (6), for a `p-0.5` (2-pt) padding (emil-surfaces 1).
 * - Segment 28 tall (the pointer hit target, `CONTROL.small`; 44 under Large hit targets), regular weight: muted when not chosen,
 *   foreground when chosen. Weight never changes with state, so a label cannot reflow (emil-ui-polish 2).
 * - The border is transparent until chosen in dark; hover lightens an unchosen one; the ring is the group's (`RadioItem`).
 * - Narrower than its options (six in a 240 pt column, a long label): the track stops at its container and each segment
 *   shrinks, its label one line cut with an ellipsis and whole in a bubble and in its name; it ran past the container.
 * - Motion: the item's fill and border ease in `RadioItem`, the label's colour here (`hoverTransition`, colour only). No
 *   sliding pill: nsh's `View::follow` is Rust-only, and a pill placed from measured bounds needs an `onLayout` per item
 *   and an animated translate that fights the roving ring.
 */
export function Segmented<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  iconOnly?: boolean;
  label?: string;
}) {
  const height = () => (largeTargets() ? "h-11" : "h-7");
  return (
    <RadioGroup
      value={props.value}
      onChange={props.onChange}
      label={props.label}
      class="max-w-full flex-row gap-px self-start rounded-md bg-muted p-0.5"
    >
      <Each of={props.options} key={(o: SegmentOption<T>) => o.value}>
        {(o) => (
          <RadioItem
            value={o().value}
            label={o().label}
            class={`${height()} min-w-0 shrink flex-row items-center gap-2 rounded-base border border-transparent hover:bg-card/60 checked:bg-card checked:shadow-sm dark:checked:border-foreground/40 dark:checked:shadow-none ${props.iconOnly ? (largeTargets() ? "w-11 justify-center" : "w-7 justify-center") : "px-3"}`}
          >
            <If when={o().icon}>
              {(name) => (
                <View class="shrink-0">
                  <Icon name={name()} size={14} tone={props.value === o().value ? "foreground" : "muted-foreground"} />
                </View>
              )}
            </If>
            <If when={!props.iconOnly}>
              <View class="min-w-0 shrink">
                <Clipped style={hoverTransition()} class="text-sm text-muted-foreground group-checked:text-foreground">
                  {o().label}
                </Clipped>
              </View>
            </If>
          </RadioItem>
        )}
      </Each>
    </RadioGroup>
  );
}
