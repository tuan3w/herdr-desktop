import { View } from "nsh";
import { statusText } from "../lib/status";
import type { AgentStatus } from "../lib/status";
import { Icon } from "./kit";

/**
 * An agent's status as a shape, so colour is never the only signal: needs you = filled disc with a bar, working =
 * half-filled ring, done = check, idle = empty ring, unknown = dashed ring. It is decorative and hidden from screen
 * readers: the row or header that shows it says `statusText` in its own accessibility label.
 */
export function StatusGlyph(props: { status: AgentStatus; size?: 12 | 14 | 16 }) {
  const size = props.size ?? 14;
  const box = { width: size, height: size };
  const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;
  const shape = () => {
    switch (props.status) {
      case "blocked":
        return (
          <View style={box} class="items-center justify-center rounded-full bg-signal" {...hidden}>
            <View style={{ width: 2, height: size * 0.5 }} class="rounded-full bg-background" />
          </View>
        );
      case "working":
        return (
          <View style={box} class="overflow-hidden rounded-full border-[1.5px] border-primary" {...hidden}>
            <View class="absolute bottom-0 left-0 top-0 w-1/2 bg-primary" />
          </View>
        );
      case "done":
        return <Icon name="check" size={size === 16 ? 16 : size === 14 ? 14 : 12} tone="success" />;
      case "idle":
        return <View style={box} class="rounded-full border-[1.5px] border-muted-foreground" {...hidden} />;
      case "unknown":
        return <View style={{ ...box, borderStyle: "dashed" }} class="rounded-full border-[1.5px] border-muted-foreground" {...hidden} />;
    }
  };
  return (
    <View style={box} class="shrink-0 items-center justify-center" {...hidden}>
      {shape()}
    </View>
  );
}

export { statusText };
