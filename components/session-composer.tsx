import { cleanup, type JSX, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

import type { SessionView } from "herdr-desktop/native";
import type { InputRef, ViewRef } from "nsh/types";

import { CommandList, MentionList } from "#components/composer-picker";
import { AttachPicker } from "#components/session-attach";
import { ChipRow, PictureStrip } from "#components/session-chips";
import { SessionModeChip, SessionModelPicker } from "#components/session-config";
import { SessionQueue } from "#components/session-queue";
import { ActionMenu, FOCUS_RING, Icon } from "#kit";
import { type Composer, createComposer } from "#lib/composer";
import { CHAT_COLUMN, COMPOSER_INPUT } from "#lib/layout";
import { pinCommand, slashMemory } from "#lib/pane-memory";
import type { SessionPort } from "#lib/session";
import { deliveryNote } from "#lib/session-compose";
import { enterNewline } from "#lib/settings";
import { GLOBAL, keysOf, keyText } from "#lib/shortcuts";
import { isPinned, usageKey } from "#lib/slash";

/** What the chat does with its message box from outside: the open of a tab, `mod+2`, `Reply…`, a drop, a shortcut. */
export interface SessionComposerHandle {
  focus(): void;
  /** Appends `text` at the end and keeps the keyboard in the box. */
  insert(text: string): void;
  /** Files dropped on the tab, as `file:` URLs of this computer. */
  drop(uris: string[]): void;
  /** Opens the system's file dialog (`mod+shift+o`). */
  attach(): void;
  /** Adds `text` to the box as a quotation (`> ` before each line). */
  quote(text: string): void;
  /** Mentions a file of the session's machine (absolute path), as if it had been picked with `@`. */
  mention(path: string): void;
}

/**
 * The message box of a chat: a rounded card with the pictures and files of the message on top, the text, and under it `+`,
 * the session's mode and model, and one round button that is `Send` and, while a turn runs with nothing typed, `Stop`.
 * The model is `lib/composer.ts`; the rules and their reasons are `design/composer.md`. In short:
 *
 * - Enter sends, Shift+Enter is a new line (Settings turns it round: Enter a new line, `mod+Enter` sends). Never while an
 *   input method is composing. While the agent works a send goes to the queue; the queue shows above the box.
 * - `@` anywhere a word could start lists the project's files and folders in a list hung over the caret: typing narrows,
 *   Up and Down move, Tab or Enter add, Right opens a folder, Escape closes it and keeps what was typed. The choice
 *   is a chip above the box and `@path` in the words. `/` at the start lists the agent's commands in the same list.
 * - Pictures (`mod+v` with a picture on the clipboard, a drop, the file dialog) are thumbnails above the box and
 *   `[Image n]` in the words; a long paste is a chip and goes out whole.
 * - Up in an empty box brings back the last message; Escape never clears the box.
 * - What was typed and attached survives a refusal, a tab switch and a project switch. Off, the box says why and takes nothing.
 */
export function SessionComposer(props: {
  machine: string;
  id: string;
  port: SessionPort;
  view: () => SessionView;
  onHandle?: (handle: SessionComposerHandle) => void;
}) {
  const c = createComposer(props);
  const card = signal<ViewRef | null>(null);
  const height = signal<number>(COMPOSER_INPUT.min);
  // A press on a row of the list takes the keyboard from the box for a moment: the list stays until the press is over.
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(blurTimer));

  props.onHandle?.({
    focus: c.focus,
    insert: c.insert,
    drop: c.dropUris,
    attach: () => void c.attachFromComputer(),
    quote: c.quote,
    mention: c.mentionPath,
  });

  const anchor = () => c.caretBounds() ?? card();
  const placeholder = () => c.off() ?? "Ask anything · @ for files · / for commands";
  const attachKey = () => keyText(keysOf(GLOBAL.attachFiles)[0]!);

  /** What the line under the box says: the failure, else what the typed command takes, else what a send does, else the keys. */
  const line = (): { text: string; alert: boolean } | null => {
    if (c.error() !== "") return { text: c.error(), alert: true };
    const ghost = c.ghost();
    if (ghost) return { text: `${c.value().trim()} takes ${ghost}`, alert: false };
    const note = deliveryNote(props.view());
    if (note) return { text: note, alert: false };
    if (c.focused() && c.off() === null)
      return {
        text: enterNewline()
          ? `${keyText("mod+enter")} send · Enter new line · @ files · / commands`
          : "Enter send · Shift+Enter new line · @ files · / commands",
        alert: false,
      };
    return null;
  };

  return (
    <View
      class={`${CHAT_COLUMN} gap-2 pb-4 pt-2`}
      ref={(node: ViewRef) => {
        card.set(node);
      }}
    >
      <If when={props.view().queue.length > 0}>
        <SessionQueue
          queue={props.view().queue}
          onTakeBack={(q) => void c.takeBack(q.id)}
          onSendNow={() => void c.sendNow()}
        />
      </If>
      <If when={c.listed() === "slash"}>
        <CommandList
          commands={c.slash()}
          highlighted={c.highlighted()}
          anchor={anchor()}
          pinned={(key) => isPinned(slashMemory(), props.view().agent, key)}
          onPick={(i) => c.pickRow(i)}
          onTogglePin={(command) => pinCommand(props.view().agent, usageKey(command))}
        />
      </If>
      <If when={c.listed() === "mention"}>
        <MentionList
          hits={c.mentions()?.hits ?? []}
          highlighted={c.highlighted()}
          anchor={anchor()}
          peek={c.peek()}
          onPick={(i) => c.pickMention(i)}
        />
      </If>
      <View class="gap-1 rounded-2xl border border-input bg-card px-4 pb-3 pt-3 focus-within:border-ring">
        <PictureStrip composer={c} />
        <ChipRow composer={c} machine={props.machine} />
        <Input
          ref={(node: InputRef) => c.setInput(node)}
          value={c.value()}
          onChange={({ value: v }) => c.onChange(v)}
          onSelectionChange={({ start }) => c.onSelection(start)}
          onCaretMove={(e) => c.onCaret(e.pageBounds)}
          onPaste={(e) => c.onPaste(e)}
          onCompositionChange={({ composing }) => c.setComposing(composing)}
          placeholder={placeholder()}
          accessibilityLabel="Message"
          disabled={c.off() !== null}
          multiline
          submitBehavior={enterNewline() ? "newline" : "submit"}
          onSubmit={() => void c.send()}
          onContentSizeChange={({ size }) =>
            height.set(Math.min(COMPOSER_INPUT.max, Math.max(COMPOSER_INPUT.min, Math.ceil(size.height) + 4)))
          }
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          onFocus={() => {
            clearTimeout(blurTimer);
            c.setFocused(true);
          }}
          onBlur={() => {
            clearTimeout(blurTimer);
            blurTimer = setTimeout(() => c.setFocused(false), 150);
          }}
          style={{ height: height() }}
          class="bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground"
        />
        <View class="flex-row items-center gap-1">
          <ActionMenu
            label="Attach"
            icon="plus"
            disabled={c.off() !== null}
            entries={[
              {
                label: "Files from this computer…",
                icon: "upload",
                shortcut: attachKey(),
                onSelect: () => void c.attachFromComputer(),
              },
              {
                label: c.local() ? "Files in the project…" : "Files on the machine…",
                icon: "folder",
                onSelect: () => c.attaching.set(true),
              },
            ]}
          />
          <SessionModeChip machine={props.machine} id={props.id} />
          <View class="flex-1" />
          <SessionModelPicker machine={props.machine} id={props.id} />
          <SendButton c={c} />
        </View>
      </View>
      <View class="min-h-4 px-1">
        <If when={line() !== null}>
          <Text
            role={line()?.alert ? "alert" : "text"}
            class={`text-xs ${line()?.alert ? "text-destructive" : "text-muted-foreground"}`}
          >
            {line()?.text}
          </Text>
        </If>
      </View>
      <AttachPicker
        open={c.attaching()}
        machine={props.machine}
        folder={c.cwd()}
        chosen={[]}
        onAttach={(paths) => {
          c.attaching.set(false);
          c.attachFromProject(paths);
        }}
        onClose={() => {
          c.attaching.set(false);
          c.focus();
        }}
      />
    </View>
  );
}

/** The round button: Send, Queue message while the agent works, Stop while a turn runs with nothing typed. */
function SendButton(props: { c: Composer }): JSX.Element {
  const c = props.c;
  const label = () => (c.showStop() ? "Stop" : c.running() ? "Queue message" : "Send message");
  const usable = () => c.canSend();
  return (
    <Button
      onPress={() => (c.showStop() ? (c.guarded() ? undefined : void c.stop()) : void c.send())}
      disabled={!usable()}
      accessibilityLabel={label()}
      class={`size-8 items-center justify-center rounded-full ${FOCUS_RING} ${usable() ? "bg-primary" : "bg-muted"} ${c.guarded() ? "opacity-60" : ""}`}
    >
      <If
        when={c.showStop()}
        else={<Icon name="arrow-up" size={16} tone={usable() ? "primary-foreground" : "muted-foreground"} />}
      >
        <View
          class="size-3 rounded-sm bg-primary-foreground"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </If>
    </Button>
  );
}
