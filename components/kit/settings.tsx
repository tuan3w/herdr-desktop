import { type JSX, Text, View } from "nsh";

/**
 * A group of `SettingRow`s under a heading: no card. The heading is one step above the body (`text-base`); the hairline
 * under it is the first row's own top rule, so rows are separated by one hairline each and the last has none under it
 * (emil-surfaces: separation borders stay borders). To add an option to the app: a signal in `lib/settings.ts`, then a
 * `SettingRow` in the section it belongs to.
 */
export function SettingsSection(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-2">
      <Text role="header" class="text-base font-medium text-foreground">
        {props.title}
      </Text>
      <View>{props.children}</View>
    </View>
  );
}

/**
 * One option: what it is (`label` at body size, plus a one-line `description` of the consequence one step smaller and
 * muted: size and tone carry the hierarchy, not weight) and the `control` that sets it, aligned right and never shrunk.
 * At least 56 tall so a row of one line is not cramped (emil-design-foundations: spacing by system).
 * The text keeps 192 pt at least: when the control and that much do not fit one line (a wide segmented control in the
 * settings dialog at 760), the control wraps under the text instead of squeezing the label to a letter per line (it did:
 * `D e n si ty`, rendered). `stacked` always puts the control under the text across the row's width, for wide controls
 * that wrap, such as the theme picker (a lone button there takes `self-start` itself).
 * `onPress` is what pressing the text does: a row of a switch toggles it, as a label toggles its control (the switch's
 * 28 pt target is too small a place to have to aim at when the whole sentence beside it names it). The text is not a
 * second Tab stop and not a second name: the switch keeps both. `disabled` takes the press away with the control and fades
 * the text with it; `reason` says why in a line of its own that is not faded (state by word, not by fade alone), read
 * after the description: "Turn on notifications first."
 */
export function SettingRow(props: {
  label: string;
  description?: string;
  control?: JSX.Element;
  stacked?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  reason?: string;
}) {
  return (
    <View
      class={`min-h-14 border-t border-border py-3 ${props.stacked ? "gap-3" : "flex-row flex-wrap items-center gap-x-6 gap-y-3"}`}
    >
      <View
        focusable={false}
        onPress={() => {
          if (!props.disabled) props.onPress?.();
        }}
        class={`gap-1 ${props.stacked ? "" : "min-w-48 flex-1"}`}
      >
        <View class={`gap-1 ${props.disabled ? "opacity-50" : ""}`}>
          <Text class="text-sm text-foreground" style={{ userSelect: "text" }}>
            {props.label}
          </Text>
          <If when={props.description}>
            <Text class="max-w-lg text-xs text-muted-foreground" style={{ userSelect: "text" }}>
              {props.description}
            </Text>
          </If>
        </View>
        <If when={props.disabled && props.reason}>
          <Text class="max-w-lg text-xs text-muted-foreground" style={{ userSelect: "text" }}>
            {props.reason}
          </Text>
        </If>
      </View>
      <If when={props.control}>
        <View class={props.stacked ? "" : "shrink-0 items-end"}>{props.control}</View>
      </If>
    </View>
  );
}
