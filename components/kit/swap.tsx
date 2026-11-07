import { effect, Text, untracked } from "nsh";

import { swapped } from "#lib/motion";

import { NUM } from "./core";

/**
 * A number or short word that changes while it is on screen (a count of agents, a tally): the new text fades in and rises
 * 4 pt (`DURATION.swap`) so the eye sees which figure moved. Tabular figures. The first text is just there, and under
 * reduced motion every one is. Not for text that is recycled by a virtual list (it would move whenever a cell changes
 * its row).
 */
export function Swap(props: { text: string; class?: string }) {
  const swap = swapped();
  let last = untracked(() => props.text);
  effect(() => {
    const text = props.text;
    if (text !== last) swap.changed();
    last = text;
  });
  return (
    <Text style={[NUM, swap.style]} class={props.class}>
      {props.text}
    </Text>
  );
}
