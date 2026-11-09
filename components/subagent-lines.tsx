import { Text, View } from "nsh";

import type { SubagentProgress } from "herdr-desktop/native";

import { StatusGlyph } from "#components/status-glyph";
import { Icon, NUM } from "#kit";
import { SUBAGENT_LINE_PT, subagentDoing, subagentLabel, subagentTime, toolCountText } from "#lib/session-subagents";
import { visibleText } from "#lib/session-text";

/**
 * A subagent's mark: the half ring while it works, a dashed ring while it waits to start, a check when it is done, a red
 * alert when it failed, a muted cross when it was stopped. The same shapes the sidebar and the chat's calls use
 * (`StatusGlyph`, `ToolStatus`), in a box of one size so the names keep one column.
 */
function Mark(props: { status: SubagentProgress["status"] }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      class="size-4 shrink-0 items-center justify-center"
    >
      {props.status === "running" ? (
        <StatusGlyph status="working" size={12} />
      ) : props.status === "pending" ? (
        <StatusGlyph status="unknown" size={12} />
      ) : props.status === "completed" ? (
        <StatusGlyph status="done" size={12} />
      ) : props.status === "failed" ? (
        <Icon name="alert" size={12} tone="destructive" />
      ) : (
        <Icon name="x" size={12} tone="muted-foreground" />
      )}
    </View>
  );
}

/**
 * One quiet line for each subagent of a `task` call, under the card's header: its mark, its name, the tool it is in (or the
 * last it finished) in muted text, and the tools it has called and how long it has run in tabular figures. Each line is one
 * labelled element (`Subagent audit, running, Reading auth.ts, 12 tools, 1m 4s`). The lines are data as it comes: a line
 * appears and changes at once (rows of a live conversation never move, `design/motion.md`), and the times are what omp last
 * reported, so nothing here ticks.
 */
export function SubagentLines(props: { list: readonly SubagentProgress[]; cwd: string }) {
  return (
    <View role="list" accessibilityLabel="Subagents" class="gap-0 px-3 pb-2">
      <Each of={props.list} key={(a: SubagentProgress) => a.id || a.name}>
        {(a) => (
          <View
            role="group"
            accessibilityLabel={subagentLabel(a(), props.cwd)}
            style={{ minHeight: SUBAGENT_LINE_PT }}
            class="flex-row items-center gap-2"
          >
            <Mark status={a().status} />
            <Text
              class="max-w-[40%] shrink-0 text-xs font-medium text-foreground"
              style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
            >
              {visibleText(a().name)}
            </Text>
            <Text
              class="min-w-0 flex-1 text-xs text-muted-foreground"
              style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
            >
              {subagentDoing(a(), props.cwd)}
            </Text>
            <Text class="shrink-0 text-xs text-muted-foreground" style={NUM}>
              {[toolCountText(a().toolCount), subagentTime(a())].filter(Boolean).join(" · ")}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}
