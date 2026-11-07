import { type JSX, Text, View } from "nsh";

/**
 * A group of `SettingRow`s under a heading and a hairline: no card, no borders between rows, the space separates
 * them. To add an option to the app: a signal in `lib/settings.ts`, then a `SettingRow` in the section it belongs to.
 */
export function SettingsSection(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-1">
      <View class="border-b border-border pb-2">
        <Text role="header" class="text-base font-medium text-foreground">
          {props.title}
        </Text>
      </View>
      <View>{props.children}</View>
    </View>
  );
}

/**
 * One option: what it is (`label`, plus a one-line `description` of the consequence) and the `control` that sets it.
 * `stacked` puts the control under the text, for wide controls such as the theme picker.
 */
export function SettingRow(props: { label: string; description?: string; control?: JSX.Element; stacked?: boolean }) {
  return (
    <View class={`gap-3 py-3.5 ${props.stacked ? "" : "flex-row items-center justify-between"}`}>
      <View class={`gap-1 ${props.stacked ? "" : "min-w-0 flex-1 pr-6"}`}>
        <Text class="text-sm text-foreground">{props.label}</Text>
        <If when={props.description}>
          <Text class="max-w-lg text-sm text-muted-foreground">{props.description}</Text>
        </If>
      </View>
      {props.control}
    </View>
  );
}
