import { Files, Herdr } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Button, Input } from "nsh/base";

import type { ActionResult, EntryView, SessionView } from "herdr-desktop/native";
import type { InputRef } from "nsh/types";

import { AttachPicker } from "#components/session-attach";
import { SessionModeChip, SessionModelPicker } from "#components/session-config";
import { SessionQueue } from "#components/session-queue";
import { SlashList } from "#components/slash-list";
import { FOCUS_RING, FOCUS_RING_INSET, Icon, IconButton, notify } from "#kit";
import { sessionKey } from "#lib/dock";
import { joinPath, sending, sizeText } from "#lib/files";
import { CHAT_COLUMN } from "#lib/layout";
import { noteSent, pinCommand, slashMemory } from "#lib/pane-memory";
import type { SessionPort } from "#lib/session";
import {
  applyMention,
  deliveryNote,
  fileName,
  MAX_FILES,
  mentionAt,
  rankEntries,
  restoreText,
  splitQuery,
} from "#lib/session-compose";
import { composerOff } from "#lib/session-text";
import { commandText, hintFor, isPinned, matchCommands, type SlashCommand, usageKey } from "#lib/slash";
import { draftOf, setDraft } from "#lib/view-state";

/** What the chat does with its message box from outside: the open of a tab, `mod+2`, `Reply…`. */
export interface SessionComposerHandle {
  focus(): void;
  /** Appends `text` at the end and keeps the keyboard in the box. */
  insert(text: string): void;
  /** Files dropped on the tab, as `file:` URLs of this computer. */
  drop(uris: string[]): void;
}

const MIN_HEIGHT = 28;
const MAX_HEIGHT = 168;
/** A Stop that just appeared takes no press for this long: the second press of a double press on Send must not stop the turn it started. */
const STOP_GUARD_MS = 400;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** `done` and `queued` took effect; every other kind is a refusal that sent nothing. */
const refused = (r: ActionResult): boolean => r.kind !== "done" && r.kind !== "queued";

const ROW = 32;

/** The files a `@` can mean: the same look as the command list, a listbox the box keeps the focus beside. */
function MentionList(props: {
  entries: EntryView[];
  dir: string;
  highlighted: number;
  onPick: (entry: EntryView) => void;
}) {
  return (
    <View role="listbox" accessibilityLabel="Files" class="overflow-hidden rounded-md border border-border bg-popover">
      <Each of={props.entries} key="index">
        {(entry, i) => (
          <Button
            role="option"
            accessibilityLabel={`${props.dir}${entry().name}${entry().kind === "dir" ? ", folder" : ""}`}
            selected={i() === props.highlighted}
            onPress={() => props.onPick(entry())}
            style={{ height: ROW }}
            class={`flex-row items-center gap-2 px-3 ${i() === props.highlighted ? "bg-accent" : ""} ${FOCUS_RING_INSET}`}
          >
            <Icon name={entry().kind === "dir" ? "folder" : "file"} size={14} tone="muted-foreground" />
            <Text
              class="min-w-0 flex-1 font-mono text-xs text-popover-foreground"
              style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
            >
              {`${props.dir}${entry().name}${entry().kind === "dir" ? "/" : ""}`}
            </Text>
            <If when={entry().kind === "file"}>
              <Text class="text-xs text-muted-foreground">{sizeText(entry().size)}</Text>
            </If>
          </Button>
        )}
      </Each>
    </View>
  );
}

/**
 * The message box of a chat: a rounded card with the text on top and, under it, `+` (attach), the session's mode and
 * model, and one round button that is `Send` and, while a turn runs with nothing typed, `Stop`.
 *
 * - Enter sends, Shift+Enter is a new line. While the agent works a send goes to the queue (`Sessions.send` says
 *   `queued`); the queue shows above the box and a cross takes a message back into it.
 * - `/` at the start lists the agent's own commands (`SessionView.commands`), `@` at the start of a word lists files of
 *   the session's folder, Up and Down move, Enter or Tab pick, Escape hides.
 * - Escape stops the turn only when this box has the focus, nothing else is using Escape (a list, a dialog) and a turn
 *   runs. A Stop that just appeared ignores presses for 400 ms.
 * - Files: `+` opens the machine's folder to tick, or drop files on the tab (`attach`); at most five. A file of this
 *   computer for a remote session is offered to `Send a file` instead, because the agent reads paths on its own machine.
 * - What was typed survives a refusal: it comes back with the reason. A message the agent refused comes back by itself.
 * - Off, the box says why (`SessionView.phase`, `connectionLost`) and takes nothing.
 */
export function SessionComposer(props: {
  machine: string;
  id: string;
  port: SessionPort;
  view: () => SessionView;
  onHandle?: (handle: SessionComposerHandle) => void;
}) {
  // What was typed and attached and not sent comes back when the project is shown again (`lib/view-state.ts`).
  const draft = sessionKey(props.machine, props.id);
  const kept = draftOf(draft);
  const value = signal(kept?.text ?? "");
  const caret = signal(kept?.text.length ?? 0);
  const files = signal<string[]>(kept?.files ?? []);
  const error = signal("");
  const focused = signal(false);
  const picked = signal(0);
  const hidden = signal(false);
  const height = signal(MIN_HEIGHT);
  const attaching = signal(false);
  const guarded = signal(false);
  const mentionEntries = signal<{ dir: string; entries: EntryView[] }>({ dir: "", entries: [] });
  let field: InputRef | undefined;
  let guardTimer: number | undefined;
  let unsentSeq = 0;
  cleanup(() => clearTimeout(guardTimer));

  const view = props.view;
  const off = () => composerOff(view());
  const local = () => Herdr.machines().find((m) => m.id === props.machine)?.local ?? true;
  const cwd = () => view().cwd;

  const commands = computed<SlashCommand[]>(() =>
    view().commands.map((c) => ({
      name: c.name,
      description: c.description,
      hint: c.hint ?? undefined,
      source: "builtIn",
      trigger: "/",
    })),
  );
  const matches = (): SlashCommand[] =>
    hidden() || off() !== null ? [] : matchCommands(value(), view().agent, commands(), slashMemory());
  const ghost = (): string | null => hintFor(value(), commands());

  const mention = computed(() => (focused() && off() === null ? mentionAt(value(), caret()) : null));
  const query = () => splitQuery(mention()?.query ?? "");
  const files4mention = (): EntryView[] => {
    const m = mention();
    if (!m || hidden()) return [];
    const q = query();
    return mentionEntries().dir === q.dir ? rankEntries(mentionEntries().entries, q.name) : [];
  };
  const listed = () => (matches().length > 0 ? "slash" : files4mention().length > 0 ? "mention" : null);

  // The folder a mention names is listed when the mention starts or moves into another folder, not at every letter.
  let listing = 0;
  effect(() => {
    const dir = mention() ? query().dir : null;
    if (dir === null) return;
    untracked(() => {
      const mine = ++listing;
      void Files.list(props.machine, dir === "" ? cwd() : joinPath(cwd(), dir.replace(/\/$/, ""))).then(
        (folder) => {
          if (mine === listing) mentionEntries.set({ dir, entries: folder.entries });
        },
        () => {
          if (mine === listing) mentionEntries.set({ dir, entries: [] });
        },
      );
    });
  });

  effect(() => setDraft(draft, { text: value(), files: files() }));

  const edit = (next: string, at?: number) => {
    value.set(next);
    caret.set(at ?? next.length);
    error.set("");
    hidden.set(false);
    picked.set(0);
  };
  const place = (text: string, at: number) => {
    edit(text, at);
    field?.focus();
    field?.setSelection(at);
  };

  const pickCommand = (command: SlashCommand) => place(`${commandText(command)} `, commandText(command).length + 1);
  const pickMention = (entry: EntryView) => {
    const m = mention();
    if (!m) return;
    const dir = query().dir;
    const next = applyMention(value(), m, caret(), `${dir}${entry.name}`, entry.kind === "dir");
    place(next.text, next.caret);
  };

  // Up, Down, Enter, Tab and Escape belong to whichever list is open while the box has the focus.
  effect(() => {
    const open = listed();
    if (!focused() || open === null) return;
    const count = () => (open === "slash" ? matches().length : files4mention().length);
    const clamp = () => Math.min(picked(), count() - 1);
    const choose = () => {
      if (open === "slash") pickCommand(matches()[clamp()]!);
      else pickMention(files4mention()[clamp()]!);
    };
    return keymap.bind(
      {
        down: () => picked.update((i) => (i >= count() - 1 ? 0 : i + 1)),
        up: () => picked.update((i) => (i <= 0 ? count() - 1 : i - 1)),
        enter: choose,
        tab: choose,
        escape: () => hidden.set(true),
      },
      { when: "always" },
    );
  });

  const running = () => view().running;
  const typed = () => value().trim() !== "" || files().length > 0;
  const showStop = () => running() && !typed();

  // A Stop that just appeared is deaf for a moment, and says so by being dim.
  effect(() => {
    if (!showStop()) return;
    untracked(() => {
      guarded.set(true);
      clearTimeout(guardTimer);
      guardTimer = setTimeout(() => guarded.set(false), STOP_GUARD_MS);
    });
  });

  const stop = async () => {
    try {
      const r = await props.port.cancel();
      if (refused(r)) error.set(r.message);
      else announce("Stopping the turn");
    } catch (e) {
      error.set(reason(e));
    }
  };

  // Escape stops a turn only from the box, and only when no list or dialog wants the key.
  effect(() => {
    if (!focused() || !running() || listed() !== null) return;
    return keymap.bind("escape", () => void stop(), { when: "always" });
  });

  const send = async () => {
    if (off() !== null || !typed()) return;
    const text = value().trim();
    const carried = files();
    edit("");
    files.set([]);
    try {
      const r = await props.port.send(text, carried);
      if (refused(r)) {
        value.update((now) => restoreText(now, text));
        files.update((now) => [...new Set([...carried, ...now])]);
        error.set(`${r.message || "Not sent"}. Your message is still in the box.`);
        announce("Message not sent");
        return;
      }
      noteSent(text, view().agent, commands());
      if (r.kind === "queued") announce("Queued. It is sent when the turn ends");
    } catch (e) {
      value.update((now) => restoreText(now, text));
      files.update((now) => [...new Set([...carried, ...now])]);
      error.set(`Could not send: ${reason(e)}. Your message is still in the box.`);
      announce("Message not sent");
    }
  };

  // What the agent refused comes back, once per refusal, in front of what was typed since.
  effect(() => {
    const unsent = view().unsent;
    if (!unsent || unsent.seq === unsentSeq) return;
    unsentSeq = unsent.seq;
    untracked(() => {
      value.update((now) => restoreText(now, unsent.text));
      files.update((now) => [...new Set([...unsent.files, ...now])]);
      error.set("The agent did not take the message. It is back in the box.");
      announce("The agent did not take the message. It is back in the box");
    });
  });

  const takeBack = async (id: number) => {
    try {
      const taken = await props.port.unqueue(id);
      if (!taken) {
        notify("Already sent");
        return;
      }
      value.update((now) => restoreText(now, taken.text));
      files.update((now) => [...new Set([...taken.files, ...now])]);
      field?.focus();
      announce("Moved back to the message box");
    } catch (e) {
      notify(reason(e), { type: "error" });
    }
  };

  const sendNow = async () => {
    try {
      const r = await props.port.releaseQueue();
      if (refused(r)) notify(r.message || "Could not send the queue", { type: "error" });
    } catch (e) {
      notify(reason(e), { type: "error" });
    }
  };

  /** Adds paths on the session's machine; the sixth says so. */
  const attach = (paths: string[]) => {
    const fresh = paths.filter((p) => !files().includes(p));
    const room = MAX_FILES - files().length;
    if (fresh.length > room) notify(`At most ${MAX_FILES} files go with one message`, { type: "error" });
    files.update((now) => [...now, ...fresh.slice(0, Math.max(0, room))]);
    if (fresh.length > 0) announce(`${files().length} ${files().length === 1 ? "file" : "files"} attached`);
  };

  /** Files dropped or pasted from this computer: attached as they are on this computer, sent to the machine first for another. */
  const fromHere = (uris: string[]) => {
    const paths = uris.map((u) => Files.pathFromUri(u)).filter((p): p is string => typeof p === "string");
    if (paths.length === 0)
      return notify("Only files from this computer can be attached by dropping", { type: "error" });
    if (local()) return attach(paths);
    sending.set({ machine: props.machine, folder: cwd(), paths });
    notify("Send them to the machine, then attach them with +");
  };
  props.onHandle?.({
    focus: () => field?.focus(),
    insert: (text) => place(value() + text, (value() + text).length),
    drop: fromHere,
  });

  const placeholder = () => (off() !== null ? off()! : "Ask anything, @ to mention files, / for commands");
  const note = () => error() || deliveryNote(view());

  return (
    <View class={`${CHAT_COLUMN} gap-2 pb-4 pt-2`}>
      <If when={view().queue.length > 0}>
        <SessionQueue queue={view().queue} onTakeBack={(q) => void takeBack(q.id)} onSendNow={() => void sendNow()} />
      </If>
      <If when={listed() === "slash"}>
        <SlashList
          commands={matches()}
          highlighted={Math.min(picked(), matches().length - 1)}
          pinned={(key) => isPinned(slashMemory(), view().agent, key)}
          onPick={pickCommand}
          onTogglePin={(command) => pinCommand(view().agent, usageKey(command))}
        />
      </If>
      <If when={listed() === "mention"}>
        <MentionList
          entries={files4mention()}
          dir={query().dir}
          highlighted={Math.min(picked(), files4mention().length - 1)}
          onPick={pickMention}
        />
      </If>
      <View class="gap-2 rounded-2xl border border-input bg-card px-4 pb-3 pt-3 focus-within:border-ring">
        <If when={files().length > 0}>
          <View class="flex-row flex-wrap gap-2 pb-1" role="list" accessibilityLabel="Attached files">
            <Each of={files()} key={(p: string) => p}>
              {(path) => (
                <View
                  role="group"
                  accessibilityLabel={`Attached: ${fileName(path())}`}
                  class="h-8 flex-row items-center gap-2 rounded-md bg-muted pl-2 pr-1"
                >
                  <Icon name="file" size={12} tone="muted-foreground" />
                  <Text
                    class="max-w-[200px] text-xs text-foreground"
                    style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
                  >
                    {fileName(path())}
                  </Text>
                  <IconButton
                    icon="x"
                    label={`Remove ${fileName(path())}`}
                    onPress={() => files.update((all) => all.filter((p) => p !== path()))}
                  />
                </View>
              )}
            </Each>
          </View>
        </If>
        <Input
          ref={(node: InputRef) => {
            field = node;
          }}
          value={value()}
          onChange={({ value: v }) => edit(v, caret())}
          onSelectionChange={({ start }) => caret.set(start)}
          onPaste={(e) => {
            if (e.uris.length > 0) fromHere(e.uris);
            else if (e.files.length > 0)
              notify("A pasted picture cannot be attached yet: save it as a file and attach that", { type: "error" });
          }}
          placeholder={placeholder()}
          accessibilityLabel="Message"
          disabled={off() !== null}
          multiline
          submitBehavior="submit"
          onSubmit={() => void send()}
          onContentSizeChange={({ size }) =>
            height.set(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(size.height) + 4)))
          }
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          style={{ height: height() }}
          class="bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground"
        />
        <View class="flex-row items-center gap-1">
          <IconButton
            icon="plus"
            label="Attach files"
            onPress={() => (off() === null ? attaching.set(true) : undefined)}
          />
          <SessionModeChip machine={props.machine} id={props.id} />
          <View class="flex-1" />
          <SessionModelPicker machine={props.machine} id={props.id} />
          <Button
            onPress={() => (showStop() ? (guarded() ? undefined : void stop()) : void send())}
            disabled={off() !== null || (!showStop() && !typed())}
            accessibilityLabel={showStop() ? "Stop" : running() ? "Queue message" : "Send message"}
            class={`size-8 items-center justify-center rounded-full ${FOCUS_RING} ${off() !== null || (!showStop() && !typed()) ? "bg-muted" : "bg-primary"} ${guarded() ? "opacity-60" : ""}`}
          >
            <If
              when={showStop()}
              else={
                <Icon
                  name="arrow-up"
                  size={16}
                  tone={typed() && off() === null ? "primary-foreground" : "muted-foreground"}
                />
              }
            >
              <View
                class="size-3 rounded-sm bg-primary-foreground"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </If>
          </Button>
        </View>
      </View>
      <If when={ghost()}>
        <Text class="px-1 text-xs text-muted-foreground">{`${value().trim()} takes ${ghost()}`}</Text>
      </If>
      <If when={note()}>
        <Text
          role={error() ? "alert" : "text"}
          class={`px-1 text-xs ${error() ? "text-destructive" : "text-muted-foreground"}`}
        >
          {note()}
        </Text>
      </If>
      <AttachPicker
        open={attaching()}
        machine={props.machine}
        folder={cwd()}
        chosen={files()}
        onAttach={(paths) => {
          attaching.set(false);
          files.set([]);
          attach(paths);
          field?.focus();
        }}
        onClose={() => {
          attaching.set(false);
          field?.focus();
        }}
      />
    </View>
  );
}
