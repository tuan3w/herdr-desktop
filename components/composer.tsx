import { Herdr } from "herdr-desktop/native";
import { announce, effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import type { InputRef } from "nsh/types";

import { Btn, INPUT_CLASS } from "#kit";
import { AGENT_KINDS } from "#lib/agent-kinds";
import { paneKey } from "#lib/dock";
import { draftOf, setDraft } from "#lib/view-state";

/** What the pane tab does with its message box from outside: the board's `Reply…`. */
export interface ComposerHandle {
  focus(): void;
}

/** How a pane's agent is named to the person: `Claude Code`, else the kind herdr reported. */
export const agentTitle = (agent: string): string => AGENT_KINDS.find((a) => a.kind === agent)?.title ?? agent;

/** The tallest the box grows to before it scrolls, in points. */
const MAX_HEIGHT = 140;
const MIN_HEIGHT = 32;

/**
 * The message box of a pane, the one way to say something to a terminal agent in a view that has no keyboard of its
 * own: Enter sends the text and presses Enter in the pane (`Herdr.sendInput`), Shift+Enter is a new line, a bare Enter
 * with nothing typed does nothing. Rules, each with a test in `pane-tab.test.tsx`:
 * - while the answer dock shows (`blocked`) a bare Enter, with nothing typed, sends nothing and says `Pick an answer
 *   above`; typed text still goes (a free-text reply to the question is a real answer);
 * - what was typed survives a failed send: it comes back with the error.
 * A `/command` is plain text here: the agent's own command list belongs to the chat, which has the agent's catalog.
 */
export function Composer(props: {
  machine: string;
  pane: string;
  /** The agent's kind, empty for a plain terminal. */
  agent: string;
  /** What the pane is called. */
  name: string;
  blocked: boolean;
  disabled: boolean;
  onHandle: (handle: ComposerHandle) => void;
  /** Text went to the pane: read it again so the view does not wait for herdr's next event. */
  onSent: () => void;
}) {
  // What was typed and not sent comes back when the project is shown again (`lib/view-state.ts`).
  const draft = paneKey(props.machine, props.pane);
  const value = signal(draftOf(draft)?.text ?? "");
  const error = signal("");
  const hint = signal("");
  const height = signal(MIN_HEIGHT);
  let field: InputRef | undefined;

  const isAgent = () => props.agent !== "";

  props.onHandle({ focus: () => field?.focus() });

  effect(() => setDraft(draft, { text: value(), files: [], refs: [] }));

  // What the person changes retires the notes about the text before it. A restore after a failed send is not an edit,
  // so it keeps its error.
  const edit = (next: string) => {
    value.set(next);
    error.set("");
    hint.set("");
  };
  // The question went away: the hint about it does too.
  effect(() => {
    if (!props.blocked) hint.set("");
  });

  const send = async (text: string) => {
    edit("");
    try {
      await Herdr.sendInput(props.machine, props.pane, text, ["enter"]);
    } catch (e) {
      // The text is not lost: it is back in the box, in front of anything typed since.
      value.update((now) => (now === "" ? text : `${text}\n${now}`));
      error.set(`Could not send: ${e instanceof Error ? e.message : String(e)}. Your message is still in the box.`);
      announce("Message not sent");
      return;
    }
    props.onSent();
  };

  const submit = (text: string) => {
    if (props.disabled) return;
    if (text.trim() === "") {
      // A bare Enter would pick whatever the agent has highlighted: the dock is where that choice is made.
      if (props.blocked) {
        hint.set("Pick an answer above");
        announce("Pick an answer above");
      }
      return;
    }
    void send(text);
  };

  const note = () => error() || hint();
  return (
    <View class="gap-2 border-t border-border bg-card px-4 pb-3 pt-3">
      <View class="flex-row items-end gap-2">
        <View class="min-w-0 flex-1">
          <Input
            ref={(node: InputRef) => {
              field = node;
            }}
            value={value()}
            onChange={({ value: v }) => edit(v)}
            placeholder={isAgent() ? `Message ${props.name}` : `Send a line to ${props.name}`}
            accessibilityLabel={isAgent() ? `Message ${props.name}` : `Send a line to ${props.name}`}
            disabled={props.disabled}
            multiline
            submitBehavior="submit"
            onSubmit={({ text }) => submit(text)}
            onContentSizeChange={({ size }) =>
              height.set(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(size.height) + 14)))
            }
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            style={{ height: height() }}
            class={`${INPUT_CLASS} py-2`}
          />
        </View>
        <Btn
          label="Send"
          name="Send message"
          variant="primary"
          disabled={props.disabled || value().trim() === ""}
          onPress={() => submit(value())}
        />
      </View>
      <If when={note()}>
        <Text role="alert" class={`px-1 text-xs ${error() ? "text-destructive" : "text-foreground"}`}>
          {note()}
        </Text>
      </If>
    </View>
  );
}
