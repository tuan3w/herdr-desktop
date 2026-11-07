import { Text, View } from "nsh";

import { Icon, Tipped } from "#kit";
import { SCOPES } from "#lib/palette/scopes";
import type { PaletteScope } from "#lib/palette/scopes";

/**
 * The scopes of the palette as a radio group at the end of the search bar: `All` and one character each (`@ # > / "`).
 * `Tab` cycles them from the keyboard (the palette binds it), a press picks one. They are never focus stops: the field
 * keeps the keyboard, the group is there to be seen, pressed and named. The name is what a screen reader says, with the
 * prefix that selects it.
 */
export function ScopeChips(props: { scope: () => PaletteScope; onPick: (scope: PaletteScope) => void }) {
  return (
    <View role="radiogroup" accessibilityLabel="Search in" class="shrink-0 flex-row items-center gap-1">
      {SCOPES.map((s) => (
        <Tipped label={s.prefix ? `${s.label} · ${s.prefix}` : s.label}>
          <View
            role="radio"
            focusable={false}
            accessibilityLabel={s.prefix ? `${s.label}, prefix ${s.prefix}` : s.label}
            accessibilityState={{ selected: props.scope() === s.id }}
            onPress={() => props.onPick(s.id)}
            class={`h-7 min-w-7 items-center justify-center rounded-md px-2 hover:bg-accent ${
              props.scope() === s.id ? "bg-accent" : ""
            }`}
          >
            <Text class={`text-xs ${props.scope() === s.id ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {s.prefix ?? "All"}
            </Text>
          </View>
        </Tipped>
      ))}
    </View>
  );
}

/**
 * The layers the person is in, as a row above the search field: `New agent session › payments` in a two-step command,
 * `Actions › payments api` in the action panel. Backspace on an empty field removes the last one. A chip is text to a
 * screen reader, because the field's own label names the step. It is the `header` of the list, not the `searchPrefix`:
 * a prefix in the search bar leaves the field without its accessibility label under nsh 0.4.0 (`design/palette.md`).
 */
export function ArgChips(props: { chips: () => string[] }) {
  return (
    <If when={props.chips().length > 0}>
      <View class="shrink-0 flex-row items-center gap-1 px-4 pb-1 pt-3">
        <Each of={props.chips()} key="index">
          {(chip, i) => (
            <View class="shrink-0 flex-row items-center gap-1">
              <View class="rounded-md bg-muted px-2 py-0.5">
                <Text class="text-xs font-medium text-foreground">{chip()}</Text>
              </View>
              <If when={i() < props.chips().length - 1}>
                <Icon name="chevron-right" size={12} tone="muted-foreground" />
              </If>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
