import { Text, View } from "nsh";
import { Button } from "nsh/base";
import type { BoardRow } from "herdr-desktop/native";
import { reviewWithUndo } from "../lib/herdr";
import { hoverTransition } from "../lib/motion";
import { isSelected, selected } from "../lib/selection";
import { ageText, rowLabel } from "../lib/sidebar";
import { AnswerDock } from "./answer-dock";
import { Btn, Clipped, FOCUS_RING_INSET, NUM, Pill } from "./kit";
import { PickBox } from "./pick-box";
import { StatusGlyph } from "./status-glyph";

/** What a row does when it is opened and what else the board needs to draw it. */
export interface RowProps {
  row: BoardRow;
  /** Name the machine on the row: the board spans more than one. */
  several: boolean;
  /** Keys of every row in display order, for Shift ranges. */
  order: () => readonly string[];
  onOpen: (row: BoardRow, options?: { reply?: boolean }) => void;
}

/** `payments-api · claude · build-box`: the folder it works in, the agent, and the machine when there are several. */
function where(row: BoardRow, several: boolean): string {
  const folder = row.cwd?.split("/").filter(Boolean).pop() ?? "";
  return [folder, row.agent, several ? row.machineName : ""].filter(Boolean).join(" · ");
}

/**
 * The picking box shows on hover or focus, and always once anything is picked (so a range can be built without
 * hunting for it); it stays in the accessibility tree and Tab either way.
 */
const pickClass = () => (selected().length > 0 ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100");

/** The part of a row that opens the agent: glyph, name, where it works, how long. */
function Opener(props: RowProps) {
  const row = () => props.row;
  return (
    <Button
      onPress={() => props.onOpen(row())}
      selected={isSelected(row().key)}
      accessibilityLabel={rowLabel(row())}
      style={hoverTransition()}
      class={`min-w-0 flex-1 flex-row items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent selected:bg-accent ${FOCUS_RING_INSET}`}
    >
      <StatusGlyph status={row().status} />
      <View class="min-w-0 flex-1">
        <Clipped class="text-sm font-medium text-foreground">{row().name}</Clipped>
        <Clipped class="text-xs text-muted-foreground">{where(row(), props.several)}</Clipped>
      </View>
      <If when={row().offline}>
        <Pill text="offline" />
      </If>
      <Text style={NUM} class="text-xs text-muted-foreground">
        {ageText(row().sinceSecs)}
      </Text>
    </Button>
  );
}

/** One agent as a line. A machine that is not connected dims it: its last known state is all there is. */
export function AgentRow(props: RowProps) {
  const row = () => props.row;
  return (
    <View class={`group flex-row items-center gap-1 ${row().offline ? "opacity-60" : ""}`}>
      <View class={pickClass()}>
        <PickBox rowKey={row().key} name={row().name} order={props.order} />
      </View>
      <Opener row={props.row} several={props.several} order={props.order} onOpen={props.onOpen} />
      <If when={row().status === "done" && !row().offline}>
        <View class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <Btn small variant="ghost" label="Reviewed" name={`Reviewed: ${row().name}`} onPress={() => reviewWithUndo([row()])} />
        </View>
      </If>
    </View>
  );
}

/**
 * An agent that needs you, with what it asks: the answers when the question is one the app understands (the one
 * `AnswerDock`, the same behaviour everywhere), else the last rows of its screen so the person can see for themselves.
 * `Reply…` opens the pane with the message box ready.
 */
export function AgentCard(props: RowProps) {
  const row = () => props.row;
  return (
    <View class="group gap-2 rounded-md border border-border bg-card px-1 py-1.5">
      <View class="flex-row items-center gap-1">
        <View class={pickClass()}>
          <PickBox rowKey={row().key} name={row().name} order={props.order} />
        </View>
        <Opener row={props.row} several={props.several} order={props.order} onOpen={props.onOpen} />
      </View>
      <View class="gap-2 px-3 pb-1.5">
        <If
          when={row().prompt}
          else={
            <If when={row().preview.length > 0}>
              <Text style={{ userSelect: "text" }} class="font-mono text-xs text-foreground">
                {row().preview.slice(-8).join("\n")}
              </Text>
            </If>
          }
        >
          {(prompt) => <AnswerDock machine={row().machine} pane={row().paneId} prompt={prompt()} />}
        </If>
        <View class="flex-row">
          <Btn small variant="ghost" label="Reply…" name={`Reply…: ${row().name}`} onPress={() => props.onOpen(row(), { reply: true })} />
        </View>
      </View>
    </View>
  );
}
