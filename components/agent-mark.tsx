import { Image, View, token } from "nsh";

import circle from "./agent-icons/circle.svg";
import codex from "./agent-icons/codex.svg";
import prompt from "./agent-icons/prompt.svg";
import spark from "./agent-icons/spark.svg";

/**
 * The mark of an agent's kind, the one place it is decided. The Claude and Codex marks keep their own brand colour
 * (the `brand` flag: the tile draws them un-tinted); every other kind is the neutral mark in the row's muted ink,
 * because the app runs a long tail of kinds herdr reports and drawing a logo for each is noise. `kind` is the string
 * herdr reports (`lib/agent-kinds.ts` is the list); a kind the app does not name falls to the neutral mark, never a hole.
 */
function agentMarkOf(kind: string) {
  if (kind === "claude") return { src: spark, brand: true };
  if (kind === "codex") return { src: codex, brand: true };
  if (kind === "omp") return { src: prompt, brand: false };
  return { src: circle, brand: false };
}

/**
 * An agent's type as a mark: the one shape of its kind in a rounded tile, so a list of mixed agents reads as a set.
 * The Claude and Codex marks keep their brand colour; every other kind is the neutral mark in the row's muted ink.
 * Decorative, like `StatusGlyph`: the row that shows it carries the agent's name in its own accessibility label, so the
 * mark is hidden from screen readers. It is the *identity* half of a row; the state is the `StatusGlyph` at the row's end.
 */
export function AgentMark(props: { kind: string }) {
  const mark = agentMarkOf(props.kind);
  return (
    <View
      class="flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted"
      style={{ pointerEvents: "none" }}
    >
      <Image
        src={mark.src}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: 12, height: 12, tintColor: mark.brand ? undefined : token("muted-foreground") }}
      />
    </View>
  );
}
