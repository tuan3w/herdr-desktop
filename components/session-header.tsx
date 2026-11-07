import { effect, lifecycle, Text, untracked, View } from "nsh";

import type { SessionView } from "herdr-desktop/native";

import { StatusGlyph } from "#components/status-glyph";
import { Btn, Clipped } from "#kit";
import { openChanges } from "#lib/changes";
import { changedFiles, readCount } from "#lib/changes-count";
import { agentName, phaseStatus, phaseText, sessionTitle } from "#lib/session-text";

/** From this much of the context window used the header says so: the agent starts to forget, which is worth a look. */
const CONTEXT_WARN = 85;

/**
 * The top of a chat: the session's state as a shape and a word, its title, and `agent · machine · folder` under it.
 * `Details` opens the overview; `Show terminal` (a session read from a terminal agent's log) goes back to the pane.
 * The state word is the one place the chat says `Needs you`, and it is announced as an alert while it is true.
 */
export function SessionHeader(props: {
  view: SessionView;
  machine: string;
  /** The tab is in front: only then does the `Changes` chip read git, once when it appears and when the agent changes state. */
  active: boolean;
  machineName: string;
  onDetails: () => void;
  onShowTerminal?: () => void;
}) {
  const status = () => phaseStatus(props.view);
  const needs = () => status() === "blocked";
  const changed = changedFiles(props.machine, props.view.cwd);
  // No timer: a read when the chat comes to the front and one each time the agent's state changes (a turn ended).
  effect(() => {
    status();
    if (!props.active || lifecycle() === "background" || !props.view.cwd) return;
    untracked(() => void readCount(props.machine, props.view.cwd));
  });
  const count = () => changed() ?? 0;
  const where = () => [agentName(props.view.agent), props.machineName, props.view.cwd].filter(Boolean).join(" · ");
  return (
    <View class="min-h-14 flex-row items-center gap-3 border-b border-border px-6 py-2">
      <StatusGlyph status={status()} />
      <View class="min-w-0 flex-1">
        <Clipped class="text-sm font-medium text-foreground">{sessionTitle(props.view, props.view.agent)}</Clipped>
        <Clipped class="text-xs text-muted-foreground">{where()}</Clipped>
      </View>
      <If when={(props.view.contextPercent ?? 0) >= CONTEXT_WARN}>
        <Text
          accessibilityLabel={`Context ${Math.round(props.view.contextPercent!)} percent full`}
          class="text-xs font-medium text-destructive"
        >{`Context ${Math.round(props.view.contextPercent!)}%`}</Text>
      </If>
      <Text
        role={needs() ? "alert" : "text"}
        class={`text-xs ${needs() ? "font-medium text-foreground" : "text-muted-foreground"}`}
      >
        {phaseText(props.view)}
      </Text>
      <If when={props.view.cwd}>
        <Btn
          small
          variant="ghost"
          icon="pencil"
          label={count() > 0 ? `Changes \u00b7 ${count()}` : "Changes"}
          name={
            count() > 0
              ? `Changes \u00b7 ${count()}, review ${count()} changed ${count() === 1 ? "file" : "files"}`
              : "Changes"
          }
          onPress={() => void openChanges(props.machine, props.view.cwd)}
        />
      </If>
      <If when={props.onShowTerminal}>
        <Btn small variant="ghost" label="Show terminal" onPress={() => props.onShowTerminal?.()} />
      </If>
      <Btn small variant="ghost" label="Details" onPress={props.onDetails} />
    </View>
  );
}
