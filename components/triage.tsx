import { announce, computed, effect, signal, Text, untracked, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import type { BoardRow } from "herdr-desktop/native";
import { board } from "../lib/herdr";
import { ageText } from "../lib/sidebar";
import { AnswerDock } from "./answer-dock";
import { Btn, Field, Icon, Modal, NUM, notify } from "./kit";
import { StatusGlyph } from "./status-glyph";

/**
 * Answer one by one: a dialog that walks the agents that need you, longest waiting first, with their answers and a
 * message box. It follows the board's own set (`board().needsYou` without the unreachable ones), so it never disagrees
 * with the count: an agent that stops waiting leaves the walk and the next one takes its place, and when none is left it
 * says `All clear`. The walk follows an agent by its key: a newcomer in the list never swaps the one being read.
 */
export function Triage(props: { open: boolean; onClose: () => void; onOpenPane: (machine: string, pane: string) => void }) {
  const waiting = computed(() => board().needsYou.filter((r) => !r.offline));
  const current = signal<string | undefined>(undefined);
  /** Where the current agent last stood, so the walk goes on from there once it is answered and leaves the list. */
  let place = 0;
  const message = signal("");
  const sentNote = signal("");

  // Starts at the first when opened; afterwards keeps to the agent being read, or to its place once it is gone.
  effect(() => {
    const rows = waiting();
    if (!props.open) {
      current.set(undefined);
      place = 0;
      return;
    }
    const at = untracked(current) === undefined ? -1 : rows.findIndex((r) => r.key === untracked(current));
    if (at >= 0) {
      place = at;
      return;
    }
    const next = rows[Math.min(place, rows.length - 1)];
    current.set(next?.key);
    place = next ? rows.indexOf(next) : 0;
    message.set("");
    sentNote.set("");
  });

  // The announcement when the walk is over: nothing else moves, so a reader would not know.
  effect(() => {
    if (props.open && waiting().length === 0) announce("All clear");
  });

  const row = computed<BoardRow | undefined>(() => waiting().find((r) => r.key === current()));
  const position = () => waiting().findIndex((r) => r.key === current());
  const step = (by: number) => {
    const rows = waiting();
    if (rows.length === 0) return;
    const next = rows[(position() + by + rows.length) % rows.length];
    current.set(next.key);
    place = rows.indexOf(next);
    message.set("");
    sentNote.set("");
  };

  async function send(target: BoardRow) {
    const text = message().trim();
    if (!text) return;
    try {
      await Herdr.sendInput(target.machine, target.paneId, text, ["enter"]);
      message.set("");
      sentNote.set(`Sent to ${target.name}`);
      notify(`Sent to ${target.name}`);
    } catch (e) {
      notify(`Could not send to ${target.name}: ${e instanceof Error ? e.message : String(e)}`, { lasting: true });
    }
  }

  return (
    <Modal
      open={props.open}
      wide
      title={waiting().length === 0 ? "All clear" : `${position() + 1} of ${waiting().length} need you`}
      description={waiting().length === 0 ? "Nothing needs you now." : undefined}
      onClose={props.onClose}
      actions={
        <>
          <If when={waiting().length > 1}>
            <Btn label="Previous agent" icon="arrow-left" onPress={() => step(-1)} />
            <Btn label="Next agent" onPress={() => step(1)} />
          </If>
          <If when={row()}>{(r) => <Btn label="Open" name={`Open ${r().name}`} onPress={() => props.onOpenPane(r().machine, r().paneId)} />}</If>
          <Btn variant="primary" label="Done" onPress={props.onClose} />
        </>
      }
    >
      <If
        when={row()}
        else={
          <View class="items-center gap-2 py-8">
            <Icon name="circle-check" size={20} tone="success" />
            <Text class="text-base font-medium text-foreground">All clear</Text>
          </View>
        }
      >
        {(r) => (
          <View class="gap-3">
            <View class="flex-row items-center gap-3">
              <StatusGlyph status={r().status} />
              <View class="min-w-0 flex-1">
                <Text class="text-sm font-medium text-foreground">{r().name}</Text>
                <Text class="text-xs text-muted-foreground">{[r().cwd?.split("/").filter(Boolean).pop(), r().agent, r().machineName].filter(Boolean).join(" · ")}</Text>
              </View>
              <Text style={NUM} class="text-xs text-muted-foreground">
                {ageText(r().sinceSecs)}
              </Text>
            </View>
            <If
              when={r().prompt}
              else={
                <If when={r().preview.length > 0}>
                  <Text style={{ userSelect: "text" }} class="font-mono text-xs text-foreground">
                    {r().preview.slice(-8).join("\n")}
                  </Text>
                </If>
              }
            >
              {(prompt) => <AnswerDock machine={r().machine} pane={r().paneId} prompt={prompt()} />}
            </If>
            <Field
              label=""
              placeholder={`Message ${r().agent || r().name}…`}
              value={message()}
              onChange={(v) => message.set(v)}
              onSubmit={() => void send(r())}
            />
            <Text class="min-h-4 text-xs text-muted-foreground">{sentNote()}</Text>
          </View>
        )}
      </If>
    </Modal>
  );
}
