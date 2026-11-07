import { computed, signal, Text, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import type { BoardRow } from "herdr-desktop/native";
import { agentsText, type BulkAction, planBulk } from "../lib/bulk";
import { allRows, board } from "../lib/herdr";
import { clear, selected } from "../lib/selection";
import { Btn, Field, Modal, notify, Switch } from "./kit";

/** The picked agents as they are now: one that left the board is gone, one that changed shows its new state. */
export const pickedRows = computed<BoardRow[]>(() => {
  const live = new Map(allRows(board()).map((r) => [r.key, r]));
  return selected().flatMap((k) => live.get(k) ?? []);
});

const VERB: Record<BulkAction, { title: string; done: string; what: string }> = {
  stop: { title: "Stop", done: "Stopped", what: "Presses Esc in each one, which stops what it is doing." },
  message: { title: "Message", done: "Messaged", what: "Types the message into each one and presses Enter." },
  close: { title: "Close", done: "Closed", what: "Closes each pane and whatever runs in it. This cannot be undone." },
};

const act = (action: BulkAction, row: BoardRow, text: string) =>
  action === "stop" ? Herdr.sendKeys(row.machine, row.paneId, ["esc"]) : action === "message" ? Herdr.sendInput(row.machine, row.paneId, text, ["enter"]) : Herdr.closePane(row.machine, row.paneId);

function Names(props: { rows: readonly BoardRow[] }) {
  return (
    <View class="gap-1">
      <Each of={props.rows} key={(r) => r.key}>
        {(r) => <Text class="text-sm text-foreground">{`${r().name} · ${r().machineName}`}</Text>}
      </Each>
    </View>
  );
}

/**
 * Asks before a bulk action, from live data: who it reaches, who is skipped and why. An agent waiting on a question is
 * skipped (a message or Esc typed into a permission menu could answer it) unless `Send anyway` is on, which it never
 * is when the dialog opens; an unreachable one is always skipped. The plan is worked out again when the button is
 * pressed, so an agent that started waiting meanwhile is not typed into. Nothing here can be undone, so there is no
 * `Undo`: the dialog is the safeguard.
 */
export function BulkConfirm(props: { action: BulkAction | undefined; onClose: () => void }) {
  const sendAnyway = signal(false);
  const text = signal("");
  const busy = signal(false);
  const action = () => props.action ?? "stop";
  const plan = computed(() => planBulk(pickedRows(), sendAnyway()));
  const ready = () => plan().targets.length > 0 && (action() !== "message" || text().trim() !== "");

  async function run() {
    const kind = action();
    const { targets } = planBulk(pickedRows(), sendAnyway());
    if (targets.length === 0 || busy()) return;
    busy.set(true);
    const results = await Promise.allSettled(targets.map((t) => act(kind, t, text().trim())));
    busy.set(false);
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${targets[i].name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []));
    const worked = targets.length - failed.length;
    notify(
      failed.length === 0
        ? `${VERB[kind].done} ${agentsText(worked)}`
        : `${worked > 0 ? `${VERB[kind].done} ${worked} · ` : ""}${failed.length} failed: ${failed[0]}`,
      { lasting: failed.length > 0 },
    );
    clear();
    sendAnyway.set(false);
    text.set("");
    props.onClose();
  }

  const cancel = () => {
    sendAnyway.set(false);
    text.set("");
    props.onClose();
  };

  return (
    <Modal
      open={props.action !== undefined}
      title={`${VERB[action()].title} ${agentsText(plan().targets.length)}`}
      description={VERB[action()].what}
      onClose={cancel}
      actions={
        <>
          <Btn label="Cancel" onPress={cancel} />
          <Btn variant={action() === "close" ? "danger" : "primary"} label={`${VERB[action()].title} ${agentsText(plan().targets.length)}`} disabled={!ready()} loading={busy()} onPress={() => void run()} />
        </>
      }
    >
      <View class="gap-4">
        <If when={action() === "message"}>
          <Field label="Message" value={text()} onChange={(v) => text.set(v)} multiline />
        </If>
        <If when={plan().targets.length > 0} else={<Text class="text-sm text-muted-foreground">No agent can be reached with this.</Text>}>
          <View class="gap-1">
            <Text role="header" class="text-xs font-medium text-muted-foreground">
              {`${VERB[action()].title} (${plan().targets.length})`}
            </Text>
            <Names rows={plan().targets} />
          </View>
        </If>
        <If when={plan().waiting.length > 0}>
          <View class="gap-1">
            <Text role="header" class="text-xs font-medium text-muted-foreground">
              {sendAnyway() ? `Waiting for an answer (included, ${plan().waiting.length})` : `Waiting for an answer (skipped)`}
            </Text>
            <Names rows={plan().waiting} />
            <View class="flex-row items-center gap-3 pt-1">
              <Switch label={action() === "close" ? "Close anyway" : "Send anyway"} checked={sendAnyway()} onChange={(v) => sendAnyway.set(v)} />
              <Text class="text-sm text-foreground">{action() === "close" ? "Close anyway" : "Send anyway"}</Text>
            </View>
          </View>
        </If>
        <If when={plan().offline.length > 0}>
          <View class="gap-1">
            <Text role="header" class="text-xs font-medium text-muted-foreground">
              Not connected (skipped)
            </Text>
            <Names rows={plan().offline} />
          </View>
        </If>
      </View>
    </Modal>
  );
}
