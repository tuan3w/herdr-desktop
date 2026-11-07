import { cleanup, Clipboard, effect, keymap, Scroll, signal, Text, token, View } from "nsh";

import type { BoardRow } from "herdr-desktop/native";

import { StatusGlyph } from "#components/status-glyph";
import { Btn, Field, IconButton, Modal, notify, RadioGroup, RadioItem } from "#kit";
import { type Note, noteWhere } from "#lib/changes";
import type { ChangesModel } from "#lib/changes-model";
import { statusText } from "#lib/status";

/**
 * The note being written on the change in view: one line of text (`Enter` keeps it, `Escape` drops it), headed by where
 * it will point. It takes the keyboard when it opens and gives it back when it closes.
 */
export function NoteComposer(props: { model: ChangesModel; onClosed?: () => void }) {
  const model = props.model;
  // The field goes away with the focus in it: the keys of the tab (`j`, `c`, ...) wait for it to be given back.
  cleanup(() => props.onClosed?.());
  const where = () => {
    const d = model.diff();
    const at = model.composing();
    const g = d && at ? d.groups[at.group] : undefined;
    if (!d || !g) return "Note";
    const place = g.endLine > g.line ? `lines ${g.line}\u2013${g.endLine}` : `line ${g.line}`;
    return `Note on change ${g.index + 1} of ${d.groups.length}, ${place}`;
  };
  effect(() => {
    if (!model.composing()) return;
    return keymap.bind("escape", () => model.cancelNote(), { when: "always" });
  });
  return (
    <View role="group" accessibilityLabel="Write a note" class="gap-2 px-4 pb-3">
      <Field
        label={where()}
        value={model.draft()}
        onChange={model.setDraft}
        placeholder="What should the agent change here?"
        onSubmit={() => model.saveNote()}
        autoFocus
      />
      <View class="flex-row items-center justify-end gap-2">
        <Btn small variant="ghost" label="Cancel" onPress={() => model.cancelNote()} />
        <Btn small variant="primary" label="Keep note" hint="Enter" onPress={() => model.saveNote()} />
      </View>
    </View>
  );
}

/** The notes of the file in view, each with where it points, the lines it quotes and a way to drop it. */
export function FileNotes(props: { model: ChangesModel; path: string }) {
  const mine = () => props.model.notes().filter((n) => n.path === props.path);
  return (
    <If when={mine().length > 0}>
      <View role="list" accessibilityLabel="Notes on this file" class="gap-2 px-4 pb-3">
        <Each of={mine()} key={(n: Note) => String(n.id)}>
          {(note) => (
            <View
              role="group"
              accessibilityLabel={`Note on ${noteWhere(note())}: ${note().text}`}
              class="flex-row items-start gap-2 rounded-md bg-muted py-2 pl-3 pr-1"
            >
              <View class="min-w-0 flex-1 gap-1">
                <Text class="font-mono text-xs text-muted-foreground">{noteWhere(note())}</Text>
                <Text class="text-sm text-foreground">{note().text}</Text>
                <If when={props.model.staleNotes().has(note().id)}>
                  <Text class="text-xs text-muted-foreground">This file changed after you wrote this note</Text>
                </If>
              </View>
              <IconButton
                icon="x"
                label={`Remove note on ${noteWhere(note())}`}
                onPress={() => props.model.removeNote(note().id)}
              />
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

/** The agent that gets the message, in the words the list of agents uses: `claude · waiting for you`. */
function agentText(row: BoardRow): string {
  return `${row.name}, ${row.agent}, ${row.session ? "chat" : "terminal"}, ${statusText(row.status)}`;
}

/**
 * What the notes will say, before anything is sent: the exact message, in full, and who gets it. The person chooses the
 * agent when several work in the checkout and presses `Send`; nothing is ever sent from the notes themselves. An agent
 * that is waiting on a question of its own cannot take it into a terminal (a message typed there would answer the
 * question), so it is listed and cannot be chosen.
 */
export function SendNotes(props: { model: ChangesModel; open: boolean; onClose: () => void }) {
  const model = props.model;
  const chosen = signal<string | null>(null);
  const sending = signal(false);
  const rows = () => model.agents();
  const blocked = (row: BoardRow) => !row.session && row.status === "blocked";
  const usable = () => rows().filter((r) => !blocked(r));
  // One agent that can take it is the default; several: the person says which.
  effect(() => {
    if (!props.open) return;
    const list = usable();
    const current = chosen();
    if (current !== null && list.some((r) => r.key === current)) return;
    chosen.set(list.length === 1 ? list[0].key : null);
  });
  const target = () => rows().find((r) => r.key === chosen());
  const stale = () => model.staleNotes().size;
  const send = async () => {
    const row = target();
    if (!row || sending()) return;
    sending.set(true);
    const ok = await model.sendNotes(row);
    sending.set(false);
    if (ok) props.onClose();
  };
  const copy = () => {
    void Clipboard.writeText(model.message()).then(() => notify("Copied the notes"));
  };
  return (
    <Modal
      open={props.open}
      wide
      title={`Send ${model.notes().length} ${model.notes().length === 1 ? "note" : "notes"} to the agent`}
      description="This is the message the agent will receive, as one message."
      onClose={props.onClose}
      actions={
        <>
          <Btn variant="ghost" label="Copy message" onPress={copy} />
          <Btn label="Cancel" onPress={props.onClose} />
          <Btn
            variant="primary"
            label="Send"
            name="Send notes"
            disabled={target() === undefined}
            loading={sending()}
            onPress={() => void send()}
          />
        </>
      }
    >
      <View class="gap-4">
        <View
          role="group"
          accessibilityLabel="The message"
          class="rounded-md"
          style={{ backgroundColor: token("code-bg") }}
        >
          <Scroll class="rounded-md" style={{ maxHeight: 240 }}>
            <View class="p-3">
              <Text class="font-mono text-xs text-foreground" style={{ userSelect: "text" }}>
                {model.message()}
              </Text>
            </View>
          </Scroll>
        </View>
        <If when={stale() > 0}>
          <Text class="text-sm text-muted-foreground">
            {`${stale() === 1 ? "1 note is" : `${stale()} notes are`} on a file that changed since you wrote it: check the line numbers, or remove it.`}
          </Text>
        </If>
        <If
          when={rows().length > 0}
          else={
            <Text class="text-sm text-muted-foreground">
              No agent is running in this folder. Copy the message to give it to one yourself.
            </Text>
          }
        >
          <View class="gap-2">
            <Text class="text-sm font-medium text-foreground">{rows().length === 1 ? "Send to" : "Which agent?"}</Text>
            <RadioGroup
              value={chosen() ?? undefined}
              onChange={(key: string) => chosen.set(key)}
              label="Which agent"
              class="gap-1"
            >
              <Each of={rows()} key={(r: BoardRow) => r.key}>
                {(row) => (
                  <RadioItem
                    value={row().key}
                    label={agentText(row())}
                    disabled={blocked(row())}
                    class="min-h-10 flex-row items-center gap-3 rounded-md px-3 hover:bg-accent checked:bg-accent"
                  >
                    <StatusGlyph status={row().status} size={12} />
                    <View class="min-w-0 flex-1">
                      <Text class="text-sm text-foreground">{row().name}</Text>
                      <Text class="text-xs text-muted-foreground">
                        {blocked(row())
                          ? "waiting for you: answer it first"
                          : `${row().agent} \u00b7 ${row().session ? "chat" : "terminal"} \u00b7 ${statusText(row().status)}`}
                      </Text>
                    </View>
                  </RadioItem>
                )}
              </Each>
            </RadioGroup>
          </View>
        </If>
        <If when={usable().length === 0 && rows().length > 0}>
          <Text class="text-sm text-muted-foreground">Every agent here is waiting for an answer.</Text>
        </If>
      </View>
    </Modal>
  );
}
