import { View } from "nsh";

import type { JSX } from "nsh";

import { ActionMenu, type MenuEntry } from "#kit";

/**
 * The tools of a code, diff or output block: icon buttons and one `...` menu for settings, no fill and no strip of
 * their own, so the block's surface is the only surface. Quiet until the pointer or the keyboard is on the block
 * (the block is a `group`); they stay named and pressable. Place it absolute over a corner, or in a header row.
 */
export function CodeTools(props: { label: string; entries: MenuEntry[]; class?: string; children?: JSX.Element }) {
  return (
    <View
      class={`flex-row items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 ${props.class ?? ""}`}
    >
      {props.children}
      <ActionMenu small label={props.label} entries={props.entries} />
    </View>
  );
}
