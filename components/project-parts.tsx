import { Text, View } from "nsh";
import type { BoardProject } from "herdr-desktop/native";
import { monogram, projectState } from "../lib/sidebar";
import { Badge, NUM } from "./kit";
import { StatusGlyph } from "./status-glyph";

/**
 * What a project's header says at a glance, as a shape and a number each (colour is never the only signal): `needs you`
 * the filled disc with a bar and a signal capsule, `working` the half ring, `to review` the check. A zero is not shown;
 * with nothing to show there is no chip at all. The group is read as one phrase (`2 need you, 1 working`), the shapes are
 * decorative.
 */
export function StateChips(props: { project: BoardProject; onSidebar?: boolean }) {
  const p = () => props.project;
  return (
    <If when={projectState(p()) !== ""}>
      <View role="group" accessibilityLabel={projectState(p())} class={`flex-row items-center ${props.onSidebar ? "gap-2" : "gap-2.5"}`}>
        <Chip count={p().needsYou} status="blocked" onSidebar={props.onSidebar} />
        <Chip count={p().working} status="working" onSidebar={props.onSidebar} />
        <Chip count={p().toReview} status="done" onSidebar={props.onSidebar} />
      </View>
    </If>
  );
}

function Chip(props: { count: number; status: "blocked" | "working" | "done"; onSidebar?: boolean }) {
  return (
    <If when={props.count > 0}>
      <View class="flex-row items-center gap-1">
        <StatusGlyph status={props.status} size={props.status === "blocked" ? 14 : 12} />
        <If
          when={props.status === "blocked"}
          else={
            <Text style={NUM} class="text-xs text-muted-foreground">
              {`${props.count}`}
            </Text>
          }
        >
          <Badge onSidebar={props.onSidebar} tone="signal" count={props.count} />
        </If>
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
