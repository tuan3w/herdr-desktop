import { effect, lifecycle, Text, untracked, View } from "nsh";

import type { SessionView } from "herdr-desktop/native";

import { SessionOverview } from "#components/session-overview";
import { Btn, Clipped, FOCUS_RING, Icon, IconButton } from "#kit";
import { openChanges } from "#lib/changes";
import { changedBranch, changedFiles, readCount } from "#lib/changes-count";
import { sessionKey } from "#lib/dock";
import { projectOf, rowOf } from "#lib/herdr";
import { hoverTransition } from "#lib/motion";
import { phaseStatus, sessionTitle } from "#lib/session-text";
import { terminalEnabled } from "#lib/settings";
import { INSPECTOR_KEY, keyLabel, keyText } from "#lib/shortcuts";
import { splitTab } from "#lib/split";

/** From this much of the context window used the header says so: the agent starts to forget, which is worth a look. */
const CONTEXT_WARN = 85;

/**
 * The top of a chat, one line: `title · project · branch`. The title opens the session's facts (`SessionOverview`:
 * agent, machine, folder, id, settings, `End session`) until the inspector exists. It carries no state word and no mark:
 * what the agent needs is the answer dock's to say, once, and the sidebar row's. `Terminal` (a session read from a
 * terminal agent's log; icon, the word and its key) opens the real terminal of the pane; it exists only while the terminal
 * tab is on in Settings (`terminalEnabled`), and off the header simply has one control fewer. `Open beside` (the columns
 * icon) splits: a chat alone in its group gets its Changes (else, with the terminal tab on, its terminal) next to it, so a
 * second view is one press away.
 * `Activity` (the list icon, only when the chat has subagents or background tasks) shows or hides the inspector.
 */
export function SessionHeader(props: {
  view: SessionView;
  machine: string;
  /** The session's id (`pane:<id>` for a terminal agent): its row on the board names the project. */
  id: string;
  /** The tab is in front: only then does the `Changes` chip read git, once when it appears and when the agent changes state. */
  active: boolean;
  onShowTerminal?: () => void;
  /** The chat has an inspector (a terminal agent with subagents or background tasks): its toggle, and whether it is open. */
  inspector?: { open: boolean; toggle: () => void };
}) {
  const status = () => phaseStatus(props.view);
  const changed = changedFiles(props.machine, props.view.cwd);
  const branch = changedBranch(props.machine, props.view.cwd);
  // No timer: a read when the chat comes to the front and one each time the agent's state changes (a turn ended).
  effect(() => {
    status();
    if (!props.active || lifecycle() === "background" || !props.view.cwd) return;
    untracked(() => void readCount(props.machine, props.view.cwd));
  });
  const count = () => changed() ?? 0;
  const title = () => sessionTitle(props.view, props.view.agent);
  const project = () => {
    const row = rowOf(
      props.id.startsWith("pane:") ? `${props.machine}/${props.id.slice(5)}` : `${props.machine}/session:${props.id}`,
    );
    return row ? projectOf(row.project)?.name : undefined;
  };
  const where = () => [project(), branch()].filter(Boolean).join(" \u00b7 ");
  return (
    <View class="min-h-12 flex-row items-center gap-3 border-b border-border px-6 py-2">
      <SessionOverview
        machine={props.machine}
        id={props.id}
        trigger={(t) => (
          <View
            role="button"
            accessibilityLabel={`${title()}, session details`}
            accessibilityState={{ expanded: t.expanded() }}
            onPress={t.onPress}
            onFocus={t.onFocus}
            onBlur={t.onBlur}
            style={hoverTransition()}
            class={`min-w-0 flex-row items-center gap-1 rounded-md px-1 hover:bg-accent ${FOCUS_RING}`}
          >
            <Clipped class="shrink text-sm font-medium text-foreground">{title()}</Clipped>
            <Icon name="chevron-down" size={14} tone="muted-foreground" />
          </View>
        )}
      />
      <Clipped class="min-w-0 flex-1 text-xs text-muted-foreground">{where()}</Clipped>
      <If when={(props.view.contextPercent ?? 0) >= CONTEXT_WARN}>
        <Text
          accessibilityLabel={`Context ${Math.round(props.view.contextPercent!)} percent full`}
          class="text-xs font-medium text-destructive"
        >{`Context ${Math.round(props.view.contextPercent!)}%`}</Text>
      </If>
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
      <If when={props.inspector}>
        {(i) => (
          <IconButton
            icon="list"
            label={i().open ? "Hide activity" : "Show activity"}
            tip="Activity"
            selected={i().open}
            shortcut={keyText(INSPECTOR_KEY)}
            onPress={() => i().toggle()}
          />
        )}
      </If>
      <IconButton
        icon="columns"
        label="Open beside"
        shortcut={keyLabel("splitRight")}
        onPress={() => void splitTab(sessionKey(props.machine, props.id), "right")}
      />
      <If when={terminalEnabled() && props.onShowTerminal}>
        <Btn
          small
          variant="outline"
          icon="terminal"
          label="Terminal"
          name="Show terminal"
          hint={keyLabel("terminalView")}
          onPress={() => props.onShowTerminal?.()}
        />
      </If>
    </View>
  );
}
