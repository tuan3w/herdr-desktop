import { announce, effect, keymap, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { InputRef } from "nsh/types";
import { Herdr } from "herdr-desktop/native";
import { AGENT_KINDS } from "../lib/agent-kinds";
import { learnPhrase, noteSent, phraseMemory, pinCommand, slashMemory } from "../lib/pane-memory";
import { quickChips } from "../lib/phrases";
import { quickPhrases } from "../lib/settings";
import { commandsOf, commandText, hintFor, isPinned, matchCommands, type SlashCommand, unknownCommand, usageKey } from "../lib/slash";
import { Btn, INPUT_CLASS } from "./kit";
import { SlashList } from "./slash-list";

/** What the pane tab does with its message box from outside: the key row's `/` and `@`, the board's `Reply…`. */
export interface ComposerHandle {
  focus(): void;
  /** Appends `text` at the end and keeps the keyboard in the box. */
  insert(text: string): void;
}

/** How a pane's agent is named to the person: `Claude Code`, else the kind herdr reported. */
export const agentTitle = (agent: string): string => AGENT_KINDS.find((a) => a.kind === agent)?.title ?? agent;

/** The tallest the box grows to before it scrolls, in points. */
const MAX_HEIGHT = 140;
const MIN_HEIGHT = 32;

/**
 * The message box of a pane: Enter sends the text and presses Enter in the pane (`Herdr.sendInput`), Shift+Enter is a new
 * line, a bare Enter with nothing typed does nothing. Rules, each with a test in `pane-tab.test.tsx`:
 * - while the answer dock shows (`blocked`) a bare Enter, with nothing typed, sends nothing and says `Pick an answer
 *   above`; typed text still goes (a free-text reply to the question is a real answer);
 * - what was typed survives a failed send: it comes back with the error;
 * - an agent pane completes `/command` from the agent's list (Up and Down move, Enter or Tab pick, Escape hides it) and
 *   holds a `/word` the agent does not list once, until `Send as message`;
 * - above the empty box, quick phrases fill it and never send;
 * - nothing typed into a shell is learned.
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
  /** Keys or text went to the pane: read it again so the mirror does not wait for herdr's next event. */
  onSent: () => void;
}) {
  const value = signal("");
  const error = signal("");
  const hint = signal("");
  const held = signal<{ word: string; text: string } | null>(null);
  const focused = signal(false);
  const picked = signal(0);
  const hidden = signal(false);
  const height = signal(MIN_HEIGHT);
  let field: InputRef | undefined;

  const isAgent = () => props.agent !== "";
  const commands = () => commandsOf(props.agent);
  const matches = (): SlashCommand[] => (isAgent() && !hidden() ? matchCommands(value(), props.agent, commands(), slashMemory()) : []);
  const chips = (): string[] => (quickPhrases() && isAgent() && !props.blocked && value() === "" ? quickChips(phraseMemory()) : []);
  const ghost = (): string | null => (isAgent() ? hintFor(value(), commands()) : null);

  props.onHandle({
    focus: () => field?.focus(),
    insert: (text) => {
      edit(value() + text);
      field?.focus();
      field?.setSelection(value().length);
    },
  });

  // What the person changes retires the notes about the text before it, and brings the list back after Escape. A restore
  // after a failed send is not an edit, so it keeps its error.
  const edit = (next: string) => {
    value.set(next);
    error.set("");
    hint.set("");
    hidden.set(false);
    picked.set(0);
    if (held()?.text !== next) held.set(null);
  };
  // The question went away: the hint about it does too.
  effect(() => {
    if (!props.blocked) hint.set("");
  });

  const pick = (command: SlashCommand) => {
    edit(`${commandText(command)} `);
    field?.focus();
    field?.setSelection(value().length);
  };

  effect(() => {
    if (!focused() || matches().length === 0) return;
    const last = () => matches().length - 1;
    return keymap.bind(
      {
        down: () => picked.update((i) => (i >= last() ? 0 : i + 1)),
        up: () => picked.update((i) => (i <= 0 ? last() : i - 1)),
        enter: () => pick(matches()[Math.min(picked(), last())]),
        tab: () => pick(matches()[Math.min(picked(), last())]),
        escape: () => hidden.set(true),
      },
      { when: "always" },
    );
  });

  // `record` is false for a command the agent does not list, sent anyway: remembering it would make the typo "known" and
  // the next one go through without the hold.
  const send = async (text: string, record = true) => {
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
    if (isAgent()) {
      if (record) noteSent(text, props.agent, commands());
      if (quickPhrases()) learnPhrase(text);
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
    const word = isAgent() ? unknownCommand(text, props.agent, commands(), slashMemory()) : null;
    if (word !== null) {
      held.set({ word, text });
      announce(`/${word} is not one of ${agentTitle(props.agent)}'s commands. Send as message, or change it.`);
      return;
    }
    void send(text);
  };

  const note = () => error() || hint();
  return (
    <View class="gap-2 border-t border-border bg-card px-4 pb-3 pt-3">
      <If when={matches().length > 0 && focused()}>
        <SlashList
          commands={matches()}
          highlighted={Math.min(picked(), matches().length - 1)}
          pinned={(key) => isPinned(slashMemory(), props.agent, key)}
          onPick={pick}
          onTogglePin={(command) => pinCommand(props.agent, usageKey(command))}
        />
      </If>
      <If when={chips().length > 0}>
        <View class="flex-row flex-wrap gap-2">
          <Each of={chips()} key={(c: string) => c}>
            {(phrase) => (
              <Btn
                small
                label={phrase()}
                name={`Quick phrase: ${phrase()}`}
                disabled={props.disabled}
                onPress={() => {
                  edit(phrase());
                  field?.focus();
                  field?.setSelection(phrase().length);
                }}
              />
            )}
          </Each>
        </View>
      </If>
      <If when={held()}>
        {(h) => (
          <View class="flex-row flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
            <Text class="min-w-0 flex-1 text-xs text-foreground">
              {`/${h().word} isn’t one of ${agentTitle(props.agent)}’s commands. Sent as it is, it goes to the agent as a message.`}
            </Text>
            <Btn
              small
              label="Send as message"
              onPress={() => {
                const text = h().text;
                held.set(null);
                void send(text, false);
              }}
            />
          </View>
        )}
      </If>
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
            onContentSizeChange={({ size }) => height.set(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(size.height) + 14)))}
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            style={{ height: height() }}
            class={`${INPUT_CLASS} py-2`}
          />
        </View>
        <Btn label="Send" name="Send message" variant="primary" disabled={props.disabled || value().trim() === ""} onPress={() => submit(value())} />
      </View>
      <If when={ghost()}>
        <Text class="px-1 text-xs text-muted-foreground">{`${value().trim()} takes ${ghost()}`}</Text>
      </If>
      <If when={note()}>
        <Text role="alert" class={`px-1 text-xs ${error() ? "text-destructive" : "text-foreground"}`}>
          {note()}
        </Text>
      </If>
    </View>
  );
}
