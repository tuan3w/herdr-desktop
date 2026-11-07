import { Text, View } from "nsh";
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
 */
export function Segmented<T extends string>(props: { value: T; onChange: (value: T) => void; options: SegmentOption<T>[]; iconOnly?: boolean; label?: string }) {
  return (
    <RadioGroup value={props.value} onChange={props.onChange} label={props.label} class="flex-row gap-1 self-start rounded-lg bg-muted p-1">
      <Each of={props.options} key={(o: SegmentOption<T>) => o.value}>
        {(o) => (
          <RadioItem
            value={o().value}
            label={o().label}
            class={`h-8 flex-row items-center gap-2 rounded-md hover:bg-card/60 checked:bg-card checked:shadow-sm ${props.iconOnly ? "w-8 justify-center" : "px-3"}`}
          >
            <If when={o().icon}>
              {(name) => (
                <View>
                  <Icon name={name()} size={14} tone={props.value === o().value ? "foreground" : "muted-foreground"} />
                </View>
              )}
            </If>
            <If when={!props.iconOnly}>
              <Text class="text-sm font-medium text-muted-foreground group-checked:text-foreground">{o().label}</Text>
            </If>
          </RadioItem>
        )}
      </Each>
    </RadioGroup>
  );
}
