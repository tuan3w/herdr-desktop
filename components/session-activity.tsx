import { type JSX, signal, Text, View } from "nsh";

import type { BackgroundRow, ObservedView, SubagentRow } from "herdr-desktop/native";

import { Disclosure } from "#components/session-tool";
import { StatusGlyph } from "#components/status-glyph";
import { Clipped, Icon } from "#kit";
import { visibleText } from "#lib/session-text";

const RUNNING = new Set(["running", "inProgress", "in_progress"]);

/** A subagent's state in the vocabulary of the status glyph: running half, finished check, anything not yet started a dashed ring. */
const glyph = (status: string): "working" | "done" | "unknown" | "blocked" =>
  RUNNING.has(status)
    ? "working"
    : status === "completed"
      ? "done"
      : status === "failed" || status === "aborted"
        ? "blocked"
        : "unknown";

/** `2 running of 3`, `3 done`: what the group's line says before it opens. */
function count(rows: readonly { running: boolean }[]): string {
  const running = rows.filter((r) => r.running).length;
  return running > 0 ? `${running} running of ${rows.length}` : `${rows.length}`;
}

function SubagentLine(props: { row: SubagentRow }) {
  const failed = () => props.row.status === "failed" || props.row.status === "aborted";
  return (
    <View
      role="group"
      accessibilityLabel={`Subagent ${props.row.name}, ${props.row.status}, ${props.row.toolCount} tool calls. ${visibleText(props.row.assignment)}`}
      class="gap-1 py-1"
    >
      <View class="flex-row items-center gap-2">
        {failed() ? (
          <Icon name="x" size={12} tone="destructive" />
        ) : (
          <StatusGlyph status={glyph(props.row.status)} size={12} />
        )}
        <Text
          class="min-w-0 flex-1 text-sm font-medium text-foreground"
          style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
        >
          {props.row.name}
        </Text>
        <Text class={`text-xs ${failed() ? "text-destructive" : "text-muted-foreground"}`}>
          {[props.row.agent, props.row.status, props.row.toolCount > 0 ? `${props.row.toolCount} tools` : ""]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <Clipped lines={2} class="pl-5 text-xs text-muted-foreground">
        {visibleText(props.row.assignment)}
      </Clipped>
      <If when={props.row.recentTools.length > 0}>
        <Text
          class="pl-5 font-mono text-xs text-muted-foreground"
          style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
        >
          {props.row.recentTools.map(visibleText).join(" › ")}
        </Text>
      </If>
    </View>
  );
}

function BackgroundLine(props: { row: BackgroundRow }) {
  return (
    <View
      role="group"
      accessibilityLabel={`${props.row.kind} ${visibleText(props.row.title)}, ${props.row.status}`}
      class="flex-row items-center gap-2 py-1"
    >
      <StatusGlyph
        status={props.row.active ? "working" : props.row.status === "failed" ? "blocked" : "done"}
        size={12}
      />
      <Text
        class="min-w-0 flex-1 font-mono text-xs text-foreground"
        style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
      >
        {visibleText(props.row.title)}
      </Text>
      <Text class="text-xs text-muted-foreground">{props.row.status}</Text>
    </View>
  );
}

function Group(props: { title: string; summary: string; children: JSX.Element }) {
  const open = signal(false);
  return (
    <View>
      <Disclosure
        label={`${props.title}, ${props.summary}`}
        open={open()}
        onPress={() => open.update((o) => !o)}
        class="min-h-9 flex-row items-center gap-2 rounded-md px-2"
      >
        <Icon name={open() ? "chevron-down" : "chevron-right"} size={14} tone="muted-foreground" />
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <Text class="text-sm text-muted-foreground">{`· ${props.summary}`}</Text>
      </Disclosure>
      <If when={open()}>
        <View class="gap-1 px-2 pb-2 pl-8">{props.children}</View>
      </If>
    </View>
  );
}

/**
 * What a terminal agent runs beside the conversation, as its log says: the subagents it started and the tasks it keeps
 * in the background, each a quiet group under the header that opens to its rows. Nothing here is stoppable: the agent
 * is in a terminal and is steered there (`Show terminal`).
 */
export function SessionActivity(props: { observed: ObservedView }) {
  const subagents = () => props.observed.subagents;
  const background = () => props.observed.background;
  return (
    <If when={subagents().length > 0 || background().length > 0}>
      <View class="border-b border-border px-2 py-1">
        <If when={subagents().length > 0}>
          <Group title="Subagents" summary={count(subagents().map((s) => ({ running: RUNNING.has(s.status) })))}>
            <Each of={subagents()} key="index">
              {(row) => <SubagentLine row={row()} />}
            </Each>
          </Group>
        </If>
        <If when={background().length > 0}>
          <Group title="Background" summary={count(background().map((b) => ({ running: b.active })))}>
            <Each of={background()} key="index">
              {(row) => <BackgroundLine row={row()} />}
            </Each>
          </Group>
        </If>
      </View>
    </If>
  );
}
