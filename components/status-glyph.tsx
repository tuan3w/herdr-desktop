import { effect, View } from "nsh";

import { Icon } from "#kit";
import { glyphChanged } from "#lib/motion";
import { statusText } from "#lib/status";
import type { AgentStatus } from "#lib/status";

/**
 * An agent's status as a shape, so colour is never the only signal: needs you = filled disc with a bar, working =
 * half-filled ring, done = check, idle = empty ring, unknown = dashed ring. It is decorative and hidden from screen
 * readers: the row or header that shows it says `statusText` in its own accessibility label.
 *
 * It is quiet by default: small, thin and in the muted ink, so a list of ten agents is ten shapes and not ten colours.
 * `loud` is the one signal-coloured form (the filled disc with its bar) and belongs to the `Needs you` inbox alone: that
 * is where an agent that waits is said once, loudly (`design/attention.md`).
 */
export function StatusGlyph(props: { status: AgentStatus; size?: 12 | 14 | 16; loud?: boolean; id?: string }) {
  const size = props.size ?? 12;
  const box = { width: size, height: size };
  // The same agent changing state pops its new shape in; a recycled row showing another agent does not.
  const change = glyphChanged();
  let last: { id: string | undefined; status: AgentStatus } | undefined;
  effect(() => {
    const now = { id: props.id, status: props.status };
    if (last && last.id !== undefined && last.id === now.id && last.status !== now.status) change.changed();
    last = now;
  });
  const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;
  const shape = () => {
    switch (props.status) {
      case "blocked":
        return (
          <View
            style={props.loud ? box : { width: size - 2, height: size - 2 }}
            class={`items-center justify-center rounded-full ${props.loud ? "bg-signal" : "bg-muted-foreground"}`}
            {...hidden}
          >
            <View style={{ width: 2, height: size * (props.loud ? 0.5 : 0.4) }} class="rounded-full bg-background" />
          </View>
        );
      case "working":
        return (
          <View style={box} class="overflow-hidden rounded-full border-[1.5px] border-muted-foreground" {...hidden}>
            <View class="absolute bottom-0 left-0 top-0 w-1/2 bg-muted-foreground" />
          </View>
        );
      case "done":
        return <Icon name="check" size={size} tone="muted-foreground" />;
      case "idle":
        return <View style={box} class="rounded-full border-[1.5px] border-muted-foreground opacity-60" {...hidden} />;
      case "unknown":
        return (
          <View
            style={{ ...box, borderStyle: "dashed" }}
            class="rounded-full border-[1.5px] border-muted-foreground opacity-60"
            {...hidden}
          />
        );
    }
  };
  return (
    <View style={[box, change.style]} class="shrink-0 items-center justify-center" {...hidden}>
      {shape()}
    </View>
  );
}

export { statusText };
