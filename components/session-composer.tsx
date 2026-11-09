import { cleanup, type JSX, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

import type { SessionView } from "herdr-desktop/native";
import type { InputRef, ViewRef } from "nsh/types";

import { CommandList, MentionList } from "#components/composer-picker";
import { AttachPicker } from "#components/session-attach";
import { ChipRow, PictureStrip } from "#components/session-chips";
import { SessionModeChip, SessionModelPicker } from "#components/session-config";
import { SessionQueue } from "#components/session-queue";
import { ActionMenu, FOCUS_RING, Icon, Tipped } from "#kit";
import { type Composer, createComposer } from "#lib/composer";
import { CHAT_COLUMN, COMPOSER_INPUT } from "#lib/layout";
import { pinCommand, slashMemory } from "#lib/pane-memory";
import type { SessionPort } from "#lib/session";
import { enterNewline } from "#lib/settings";
import { GLOBAL, keysOf, keyText } from "#lib/shortcuts";
import { isPinned, usageKey } from "#lib/slash";

/**
 * Below this box width the long placeholder (about 290 pt of `text-sm`) does not fit the field, which is the box less its
 * 12-pt edges: it wrapped to a second line the field cut (a pane at 960 split in two). The box then says `Ask anything`
 * alone; `@` and `/` are in the `+` menu and the keyboard sheet.
 */
const FULL_HINT_MIN = 320;

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
 * The message box of a chat: one card in two tiers, the pictures, files and text of the message on top, then a row
 * inside the card of `+`, the session's mode and model, and one round button that is `Send` and, while a turn runs with
 * nothing typed, `Stop`. The model is `lib/composer.ts`; the rules and their reasons are `design/composer.md`. In short:
 *
 * - Enter sends, Shift+Enter is a new line (Settings turns it round: Enter a new line, `mod+Enter` sends). Never while an
 *   input method is composing. While the agent works a send goes to the queue; the queue shows above the box.
 * - `@` anywhere a word could start lists the project's files and folders in a list that is the card's own top: typing
 *   narrows, Up and Down move, Tab or Enter add, Right opens a folder, Escape closes it and keeps what was typed. The choice
 *   is a chip above the text and `@path` in the words. `/` at the start lists the agent's commands and skills in the same list.
 * - Pictures (`mod+v` with a picture on the clipboard, a drop, the file dialog) are thumbnails above the text and
 *   nothing in the words (no `[Image #n]`); a long paste is a chip and goes out whole.
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

  // The lists hang from the box, not the caret: a second line or a picture strip moves the caret, and a list that follows it
  // would move under the pointer. They take the box's width (`boxWidth`) and sit on its top edge.
  const box = signal<ViewRef | null>(null);
  // While the commands are listed the box says what typing does; while the agent works it says where a message goes, once,
  // instead of a note under the box (the keys of the list and the keyboard sheet say the rest). A chat read from a terminal
  // has no queue: the words are typed into the pane at once, so it says so instead of promising a wait.
  const terminal = () => !!props.view().observed;
  const boxWidth = signal(0);
  const placeholder = () =>
    c.off() ??
    (c.listed() === "slash"
      ? "Type to filter"
      : c.running()
        ? terminal()
          ? "Send to the terminal"
          : "Queue a message"
        : boxWidth() > 0 && boxWidth() < FULL_HINT_MIN
          ? "Ask anything"
          : "Ask anything · @ for files · / for commands");
  const attachKey = () => keyText(keysOf(GLOBAL.attachFiles)[0]!);

  /** What the line under the words, inside the box, says: the failure, else what the typed command takes. Help is not here: the placeholder says how to start and where a message goes, the keyboard sheet lists the keys. */
  const line = (): { text: string; alert: boolean } | null => {
    if (c.error() !== "") return { text: c.error(), alert: true };
    const ghost = c.ghost();
    if (ghost) return { text: `${c.value().trim()} takes ${ghost}`, alert: false };
    return null;
  };

  return (
    <View class={`${CHAT_COLUMN} gap-1 pb-4 pt-2`}>
      <If when={props.view().queue.length > 0}>
        <SessionQueue
          queue={props.view().queue}
          onTakeBack={(q) => void c.takeBack(q.id)}
          onSendNow={() => void c.sendNow()}
        />
      </If>
      {/* The lists hang from the box's top edge at its width: the box's own top while they are open (`ComposerPicker`). */}
      <If when={c.listed() === "slash"}>
        <CommandList
          commands={c.slash()}
          highlighted={c.highlighted()}
          anchor={box()}
          width={boxWidth()}
          pinned={(key) => isPinned(slashMemory(), props.view().agent, key)}
          onPick={(i) => c.pickRow(i)}
          onTogglePin={(command) => pinCommand(props.view().agent, usageKey(command))}
        />
      </If>
      <If when={c.listed() === "mention"}>
        <MentionList
          hits={c.mentions()?.hits ?? []}
          highlighted={c.highlighted()}
          anchor={box()}
          width={boxWidth()}
          peek={c.peek()}
          onPick={(i) => c.pickMention(i)}
        />
      </If>
      {/*
        One surface, two tiers: the words (pictures, chips, the field and an alert, all on one 12-pt edge), then one row of
        controls inside the box (attach, mode, model, send). Nothing hangs under the box.
      */}
      <View
        ref={(node: ViewRef) => {
          box.set(node);
        }}
        onLayout={({ bounds }) => boxWidth.set(bounds.size.width)}
        class={`rounded-xl border border-border bg-card focus-within:border-ring focus-within:outline-[0.5px] focus-within:outline-offset-0 focus-within:outline-ring ${
          c.listed() !== null ? "rounded-t-none" : ""
        }`}
      >
        <View class="gap-2 px-3 pt-3">
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
            class="min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground"
          />
          <If when={line() !== null}>
            <Text
              role={line()?.alert ? "alert" : "text"}
              class={`text-xs ${line()?.alert ? "text-destructive" : "text-muted-foreground"}`}
              style={{ numberOfLines: line()?.alert ? 3 : 1, textOverflow: "ellipsis" }}
            >
              {line()?.text}
            </Text>
          </If>
        </View>
        <View class="flex-row items-center gap-1 px-2 pb-2 pt-1">
          <ActionMenu
            label="Attach"
            icon="plus"
            disabled={c.off() !== null}
            entries={[
              {
                label: "Add files or photos",
                icon: "upload",
                shortcut: attachKey(),
                onSelect: () => void c.attachFromComputer(),
              },
              {
                label: c.local() ? "Files in the project…" : "Files on the machine…",
                icon: "folder",
                onSelect: () => c.attaching.set(true),
              },
              { label: "Mention a file", icon: "file", onSelect: () => c.insert(startsWord(c.value()) ? "@" : " @") },
              {
                label: "Slash commands",
                icon: "terminal",
                // A command is only the first word of the message.
                disabled: c.value() !== "",
                onSelect: () => c.insert("/"),
              },
            ]}
          />
          <SessionModeChip machine={props.machine} id={props.id} />
          <SessionModelPicker machine={props.machine} id={props.id} />
          <View class="flex-1" />
          <SendButton c={c} terminal={terminal()} />
        </View>
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

/** Whether a character typed at the end of `text` starts a word, which `@` needs to mean a mention. */
const startsWord = (text: string): boolean => text === "" || /\s$/.test(text);

/**
 * The round button: Send, Queue message while the agent works (Send to the terminal for a chat read from a terminal, which
 * has no queue), Stop while a turn runs with nothing typed. Stop is a muted
 * ring, not a filled button: while the agent works nothing needs the person, and a filled Stop was the loudest thing on
 * screen (`design/taste.md`, hierarchy by subtraction). Its tooltip carries the key that also stops the turn.
 */
function SendButton(props: { c: Composer; terminal: boolean }): JSX.Element {
  const c = props.c;
  const label = () =>
    c.showStop() ? "Stop" : c.running() ? (props.terminal ? "Send to the terminal" : "Queue message") : "Send message";
  const usable = () => c.canSend();
  return (
    <Tipped label={label()} shortcut={c.showStop() ? keyText("escape") : undefined} side="top">
      <Button
        onPress={() => (c.showStop() ? (c.guarded() ? undefined : void c.stop()) : void c.send())}
        disabled={!usable()}
        accessibilityLabel={label()}
        class={`size-8 items-center justify-center rounded-full ${FOCUS_RING} ${c.showStop() ? "border border-border bg-transparent" : usable() ? "bg-primary" : "bg-muted"} ${c.guarded() ? "opacity-60" : ""}`}
      >
        <If
          when={c.showStop()}
          else={<Icon name="arrow-up" size={16} tone={usable() ? "primary-foreground" : "muted-foreground"} />}
        >
          <View
            class="size-3 rounded-sm bg-foreground"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </If>
      </Button>
    </Tipped>
  );
}
