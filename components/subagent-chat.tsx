import { cleanup, signal, Text, View } from "nsh";

import { SessionTranscript } from "#components/session-transcript";
import { Btn, Clipped, Empty, IconButton } from "#kit";
import { BAR } from "#lib/layout";
import { createSessionModel, latest, type SubagentPort } from "#lib/session";
import { agoText, elapsedText, type Entry } from "#lib/session-inspector";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The subagent's state, said once at the top of its conversation: `Running · 4m`, `Failed`, `Finished 35 min ago`. */
function stateLine(e: Entry | undefined, now: number): string {
  if (!e) return "";
  switch (e.state) {
    case "running":
      return e.startedMs !== undefined ? `Running · ${elapsedText(now - e.startedMs)}` : "Running";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return e.endedMs !== undefined ? `Finished ${agoText(now - e.endedMs)}` : "Finished";
  }
}

/**
 * A subagent's own conversation, inside the inspector: `Back`, its name and state, the transcript read from its own log
 * with the chat's components (the whole assignment is its first message), and one line that says it is read-only. There
 * is no message box: a subagent is steered through its parent, which relays. It reads only while shown (`sub.open` on
 * mount, `sub.close` when it goes), so two transcripts are never live in one list host.
 */
export function SubagentChat(props: {
  name: string;
  /** The row it was opened from; absent once the parent's log no longer names it. */
  entry: Entry | undefined;
  sub: SubagentPort;
  parentTitle: string;
  machine: string;
  active: boolean;
  panel: string;
  now: number;
  onBack: () => void;
}) {
  // The port is this conversation's for its whole life: the prop may already name another (or none) when it goes.
  const sub = props.sub;
  const failure = signal<string | null>(null);
  const atEnd = signal(true);
  const unseen = signal(0);
  const model = createSessionModel(sub.port, { answered: () => {}, streamed: () => {}, arrived: () => {} });
  const open = async () => {
    failure.set(null);
    try {
      await sub.open();
    } catch (e) {
      failure.set(reason(e));
    }
  };
  void open();
  cleanup(() => sub.close());
  const ctx = {
    machine: props.machine,
    id: sub.id,
    get cwd() {
      return model.view()?.cwd ?? "";
    },
    model,
    // Its first message is the assignment its parent wrote, in Markdown.
    fromAgent: true,
  };
  const linkText = () => {
    const o = model.view()?.observed;
    return o && o.link !== "following" ? (o.linkText ?? "") : "";
  };
  return (
    <View accessibilityLabel={`Subagent conversation: ${props.name}`} class="min-h-0 flex-1">
      <View style={{ minHeight: BAR }} class="flex-row items-center gap-2 border-b border-border pl-1 pr-3">
        <IconButton icon="chevron-left" label="Back to activity" onPress={props.onBack} />
        <View class="min-w-0 flex-1">
          <Clipped class="text-sm font-medium text-foreground">{props.name}</Clipped>
          <If when={stateLine(props.entry, props.now)}>
            <Text class={`text-xs ${props.entry?.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
              {stateLine(props.entry, props.now)}
            </Text>
          </If>
        </View>
      </View>
      <If
        when={failure()}
        else={
          <If
            when={model.view() && !linkText()}
            else={
              <Empty
                fill
                icon="clock"
                title={linkText() || "Opening the conversation…"}
                hint={props.entry?.assignment || undefined}
              />
            }
          >
            {(_) => {
              const view = latest(model.view);
              return (
                <SessionTranscript
                  ctx={ctx}
                  panel={props.panel}
                  active={props.active}
                  atEnd={atEnd}
                  unseen={unseen}
                  waiting={() => false}
                  opening={() => view().phase === "connecting"}
                />
              );
            }}
          </If>
        }
      >
        {(message) => (
          <Empty fill icon="alert" title="Cannot open this conversation" hint={message()}>
            <Btn label="Try again" onPress={() => void open()} />
          </Empty>
        )}
      </If>
      <Text class="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {`Read only. Messages go to ${props.parentTitle}, which relays them.`}
      </Text>
    </View>
  );
}
