import { Text, View } from "nsh";
import type { BoardProject } from "herdr-desktop/native";
import { monogram, projectState, projectSummary } from "../lib/sidebar";
import { Badge, NUM } from "./kit";

/**
 * What a project says about its agents, said once: the signal dot while anything waits (the only coloured mark a project
 * carries) and the rest as muted words. In the sidebar (`compact`) that is the dot and the number; on a card it is every
 * part (`2 waiting · 2 working · 1 to review`). Nothing here repeats the agents' own rows. The group is read as one phrase
 * (`2 need you, 1 working`) unless `decorative` (inside a control whose own group already says it); the dot and the words
 * are decorative either way.
 */
export function ProjectMark(props: { project: BoardProject; compact?: boolean; onSidebar?: boolean; decorative?: boolean }) {
  const p = () => props.project;
  return (
    <If when={projectState(p()) !== ""}>
      <View
        role={props.decorative ? undefined : "group"}
        accessibilityLabel={props.decorative ? undefined : projectState(p())}
        accessibilityElementsHidden={props.decorative}
        importantForAccessibility={props.decorative ? "no-hide-descendants" : undefined}
        class="flex-row items-center gap-2"
      >
        <If when={p().needsYou > 0}>
          <Badge dot tone="signal" onSidebar={props.onSidebar} />
        </If>
        <Text style={NUM} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" class="text-xs text-muted-foreground">
          {projectSummary(p(), props.compact === true)}
        </Text>
      </View>
    </If>
  );
}

/** One tint per `MONOGRAM_TONES`: theme tokens only, none of them the signal colour (that one means "needs you"). */
const TINT = ["bg-info/15 dark:bg-info/10", "bg-success/15 dark:bg-success/10", "bg-primary/15 dark:bg-primary/10", "bg-muted"];
const INK = ["text-info", "text-success", "text-primary", "text-muted-foreground"];

/** A project's tile: its first letters on a tint chosen from its name. Decorative: the name is said next to it. */
export function Monogram(props: { name: string; size?: number }) {
  const mark = () => monogram(props.name);
  const size = () => props.size ?? 32;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size(), height: size() }}
      class={`shrink-0 items-center justify-center rounded-lg ${TINT[mark().tone]}`}
    >
      <Text class={`text-xs font-semibold ${INK[mark().tone]}`}>{mark().letters}</Text>
    </View>
  );
}
