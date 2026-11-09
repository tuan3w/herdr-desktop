import { computed, effect, type JSX, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { EffectKindName } from "herdr-desktop/native";

import { type Folds, MarkdownText } from "#components/markdown";
import { MessageFiles } from "#components/message-files";
import { DiffStat, Disclosure, PartChips, ToolDetails, ToolRow, ToolStatus } from "#components/session-tool";
import { SubagentLines } from "#components/subagent-lines";
import { TurnPictures } from "#components/turn-pictures";
import { ActionMenu, type CopyEntry, copyMenu, copyText, FOCUS_RING, Icon, type IconName, IconButton, NUM } from "#kit";
import { openChanges } from "#lib/changes";
import { CHAT_COLUMN } from "#lib/layout";
import type { LinkPanel } from "#lib/link-panel";
import { ofKind } from "#lib/list-item";
import { filesLabel, messageFiles } from "#lib/message-files";
import { type Arrivals, arrivals, arriving } from "#lib/motion";
import { tally } from "#lib/perf-counts";
import { plainText } from "#lib/plain-text";
import type { SessionModel } from "#lib/session";
import { withoutPlaceholders } from "#lib/session-pictures";
import { type Call, type External, type Failure, itemKey, moreKey, type Row } from "#lib/session-rows";
import { linesShown, subagentsOf, subagentSummary } from "#lib/session-subagents";
import { durationText, itemLabel, toolLine, toolStatusText, visibleText, workLine } from "#lib/session-text";

/** The widest a line of the conversation is: past this, text is hard to follow and the window is better left calm. */
const COLUMN = CHAT_COLUMN;

/** Where a chat is: what a row needs to open files and to remember what is open. */
export interface RowContext {
  machine: string;
  /** The session's id: pictures of a terminal's log are fetched through it. */
  id: string;
  cwd: string;
  model: SessionModel;
  /** The chat's side panel: where a pressed link or picture of the agent's words opens. */
  links?: LinkPanel;
  /**
   * The "you" of this transcript is an agent: a subagent's assignment and what its parent relays, written in Markdown.
   * The person's own messages stay their typed words (Markdown would eat the `*` of a glob, a `<Tag>` and line breaks).
   */
  fromAgent?: boolean;
}

function Line(props: { children: JSX.Element; class?: string }) {
  return <View class={`${COLUMN} ${props.class ?? ""}`}>{props.children}</View>;
}

/**
 * What the person wrote: a bubble on the right; the agent's words are on the page, not in a bubble. The files it carries
 * (`messageFiles`: a terminal chat's `@path`, a keeper's attachments) are tiles and chips under the words, and their tokens
 * leave the words. A message an agent wrote (`RowContext.fromAgent`) is Markdown in the same bubble, at the bubble's size.
 */
function UserRow(props: { row: Extract<Row, { kind: "user" }>; ctx: RowContext }) {
  tally("row.mount");
  // The pictures stand where the agent's `[Image #55]` placeholders named them.
  const text = () => visibleText(withoutPlaceholders(props.row.item.text ?? "", props.row.item.images.length));
  const split = computed(() =>
    props.ctx.fromAgent
      ? { text: text(), files: [], rest: props.row.item.parts }
      : messageFiles(text(), props.row.item.parts),
  );
  const label = () => {
    const { text: words, files } = split();
    const said = itemLabel({ ...props.row.item, text: words });
    return files.length === 0
      ? said
      : `${said}${words === "" ? "" : /[.!?]$/.test(said) ? " " : ". "}${filesLabel(files)}`;
  };
  const copy = (): CopyEntry[] => [{ label: "Copy message", onSelect: () => void copyText(text(), "Message") }];
  return (
    <Line class="items-end pt-3">
      <View role="group" accessibilityLabel={label()} class="max-w-[85%] rounded-2xl bg-muted px-4 py-2">
        <If when={split().text}>
          <If
            when={props.ctx.fromAgent}
            else={
              <Text style={{ userSelect: "text" }} class="text-sm text-foreground" onContextMenu={copyMenu(copy)}>
                {split().text}
              </Text>
            }
          >
            <MarkdownText
              source={text()}
              machine={props.ctx.machine}
              folder={props.ctx.cwd}
              links={props.ctx.links}
              size="sm"
              folds={foldsOf(props.ctx.model)}
              foldKey={props.row.key}
              entries={() => [
                ...copy(),
                { label: "Copy as Markdown", onSelect: () => void copyText(text(), "Markdown") },
              ]}
            />
          </If>
        </If>
        <If when={split().files.length > 0}>
          <MessageFiles
            under={split().text !== ""}
            files={split().files}
            at={{ machine: props.ctx.machine, folder: props.ctx.cwd, links: props.ctx.links }}
          />
        </If>
        <If when={props.row.item.images.length > 0}>
          <TurnPictures images={props.row.item.images} machine={props.ctx.machine} id={props.ctx.id} />
        </If>
        <PartChips parts={split().rest} machine={props.ctx.machine} cwd={props.ctx.cwd} links={props.ctx.links} />
      </View>
    </Line>
  );
}

/** The fold state of a message's code blocks, kept in the model by key because the list recycles the cell that draws them. */
const foldsOf = (model: SessionModel): Folds => ({
  get: (key) => model.chosen(key),
  set: (key, open) => model.choose(key, !open),
});

/** What the agent said, as Markdown on the page. A press-free `Copy message` appears with the pointer or the focus. */
function AgentRow(props: { row: Extract<Row, { kind: "agent" }>; ctx: RowContext }) {
  tally("row.mount");
  const source = () => props.row.item.text ?? "";
  const folds = foldsOf(props.ctx.model);
  const entries = (): CopyEntry[] => [
    { label: "Copy message", onSelect: () => void copyText(plainText(source()), "Message") },
    { label: "Copy as Markdown", onSelect: () => void copyText(source(), "Markdown") },
  ];
  return (
    <Line class="group py-1">
      <View role="group" accessibilityLabel={itemLabel(props.row.item)}>
        <MarkdownText
          source={source()}
          machine={props.ctx.machine}
          folder={props.ctx.cwd}
          links={props.ctx.links}
          streaming={props.row.live}
          folds={folds}
          foldKey={props.row.key}
          entries={entries}
        />
        <If when={props.row.item.images.length > 0}>
          <TurnPictures images={props.row.item.images} machine={props.ctx.machine} id={props.ctx.id} />
        </If>
        <PartChips
          parts={props.row.item.parts}
          machine={props.ctx.machine}
          cwd={props.ctx.cwd}
          links={props.ctx.links}
        />
      </View>
      <If when={!props.row.live}>
        {/* In the row's own flow and reserved at rest, so it never overlaps the row above or shifts the text on hover. */}
        <View class="h-8 flex-row items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            icon="copy"
            label="Copy message"
            tipSide="top"
            onPress={() => void copyText(plainText(source()), "Message")}
          />
          <ActionMenu small label="Message options" entries={entries()} />
        </View>
      </If>
    </Line>
  );
}

/**
 * `Read 8 files, ran 4 commands, edited 3 files ›`: a folded group of calls, thoughts and narration as one muted line;
 * a press opens it to its steps. Nothing here is a link: what the turn did that matters is in the effects row.
 */
function WorkRow(props: { row: Extract<Row, { kind: "work" }>; model: SessionModel }) {
  tally("row.mount");
  const work = () => props.row.work;
  const line = () => workLine(work().summary);
  return (
    <Line class="py-2">
      <Disclosure
        onPress={() => props.model.toggle(props.row)}
        label={line()}
        open={work().open}
        class="-ml-2 min-h-9 flex-row items-center gap-2 self-start rounded-md px-2"
      >
        <Text class="text-sm text-muted-foreground">{line()}</Text>
        {/* No +N −N here: the turn's effects row says the lines changed once, as the way into Changes. */}
        <Icon name={work().open ? "chevron-down" : "chevron-right"} size={12} tone="muted-foreground" />
      </Disclosure>
    </Line>
  );
}

/** What the agent said between two calls: muted, inside the fold, so the turn's last message is the only one on the page. */
function NarrationRow(props: { row: Extract<Row, { kind: "narration" }>; ctx: RowContext }) {
  tally("row.mount");
  return (
    <Line class="py-1">
      <MarkdownText
        source={props.row.item.text ?? ""}
        machine={props.ctx.machine}
        folder={props.ctx.cwd}
        links={props.ctx.links}
        class="text-muted-foreground"
        folds={foldsOf(props.ctx.model)}
        foldKey={props.row.key}
      />
    </Line>
  );
}

const EFFECT_ICONS: Record<EffectKindName, IconName> = {
  push: "upload",
  delete: "trash",
  install: "download",
  publish: "globe",
  infra: "monitor",
  other: "list",
};

/**
 * What a finished turn did that must not hide in a fold, in the order that matters: what failed (in the warning colour,
 * with the last line it printed), what happened outside this machine, then the edits as a link to the changes.
 */
function EffectsRow(props: { row: Extract<Row, { kind: "effects" }>; ctx: RowContext }) {
  tally("row.mount");
  const fx = () => props.row.effects;
  const edited = () => fx().edited;
  const editedText = () => {
    const e = edited();
    return e ? `Edited ${e.files} ${e.files === 1 ? "file" : "files"}` : "";
  };
  return (
    <Line class="gap-1 py-1">
      <Each of={fx().failures} key={(f: Failure) => f.id}>
        {(f) => (
          <View
            role="group"
            accessibilityLabel={`Failed: ${f().text}${f().result ? `, ${f().result}` : ""}`}
            class="flex-row items-center gap-2"
          >
            <Icon name="alert" size={14} tone="warning" />
            <Text class="min-w-0 flex-1 text-sm text-warning" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
              {`${f().text}${f().result ? ` · ${f().result}` : ""}`}
            </Text>
          </View>
        )}
      </Each>
      <Each of={fx().external} key={(x: External) => x.id}>
        {(x) => (
          <View role="group" accessibilityLabel={x().text} class="flex-row items-center gap-2">
            <Icon name={EFFECT_ICONS[x().kind]} size={14} tone="foreground" />
            <Text class="min-w-0 flex-1 text-sm text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
              {x().text}
            </Text>
          </View>
        )}
      </Each>
      <If when={edited()}>
        {(e) => (
          <Button
            onPress={() => void openChanges(props.ctx.machine, props.ctx.cwd, { edited: e().paths })}
            accessibilityLabel={`${editedText()}, ${e().added} added, ${e().removed} removed. Open changes`}
            class={`-ml-2 min-h-9 flex-row items-center gap-2 self-start rounded-md px-2 hover:bg-accent ${FOCUS_RING}`}
          >
            <Icon name="pencil" size={14} tone="muted-foreground" />
            <Text class="text-sm text-muted-foreground">{editedText()}</Text>
            <DiffStat added={e().added} removed={e().removed} />
          </Button>
        )}
      </If>
    </Line>
  );
}

/** One thought, a line that opens to what the agent reasoned. */
function ThoughtRow(props: { row: Extract<Row, { kind: "thought" }>; ctx: RowContext }) {
  tally("row.mount");
  const label = () => (props.row.seconds === null ? "Thought" : `Thought for ${durationText(props.row.seconds)}`);
  return (
    <Line>
      <Disclosure
        onPress={() => props.ctx.model.toggle(props.row)}
        label={label()}
        open={props.row.open}
        class="-ml-2 min-h-8 flex-row items-center gap-2 self-start rounded-md px-2"
      >
        <Icon name="lightbulb" size={14} tone="muted-foreground" />
        <Text class="text-sm text-muted-foreground">{label()}</Text>
        <Icon name={props.row.open ? "chevron-down" : "chevron-right"} size={12} tone="muted-foreground" />
      </Disclosure>
      <If when={props.row.open}>
        <View class="pb-1 pt-1">
          <MarkdownText
            source={props.row.item.text ?? ""}
            machine={props.ctx.machine}
            folder={props.ctx.cwd}
            class="text-muted-foreground"
            folds={foldsOf(props.ctx.model)}
            foldKey={props.row.key}
          />
        </View>
      </If>
    </Line>
  );
}

/**
 * A run of calls: one hairline box (radius lg), its rows split by single hairlines, no card per row. It is one view
 * because a box cannot be cut across the list's rows: every row's corners, sides and joins are this one outline, and a
 * row that opens grows the box. Each row opens to its details in place.
 */
function CallsBox(props: { row: Extract<Row, { kind: "calls" }>; ctx: RowContext }) {
  tally("row.mount");
  const first = () => props.row.calls[0]!.item.id;
  return (
    <Line class="py-1">
      <View role="group" accessibilityLabel="Calls" class="overflow-hidden rounded-lg border border-border">
        <Each of={props.row.calls} key={(c: Call) => c.item.id}>
          {(call) => (
            <View class={call().item.id === first() ? "" : "border-t border-border"}>
              <ToolRow
                tool={call().item.tool!}
                cwd={props.ctx.cwd}
                open={call().open}
                retried={call().retried}
                onToggle={() => props.ctx.model.choose(itemKey(call().item.id), call().open)}
              />
              <If when={call().open}>
                <ToolDetails
                  tool={call().item.tool!}
                  machine={props.ctx.machine}
                  cwd={props.ctx.cwd}
                  links={props.ctx.links}
                  all={call().all}
                  onMore={() => props.ctx.model.choose(moreKey(call().item.id), call().all)}
                />
              </If>
            </View>
          )}
        </Each>
      </View>
    </Line>
  );
}

/**
 * A call that started another agent: a bordered line with its state, outside the fold, open to what it handed back. An
 * omp `task` call also says how its subagents do: one quiet line each under the header (`SubagentLines`), always in view
 * while one works; when all are done the lines fold behind the chevron and the header says `3 subagents, 2m 10s`.
 */
function SubagentRow(props: { row: Extract<Row, { kind: "subagent" }>; ctx: RowContext }) {
  tally("row.mount");
  const tool = () => props.row.item.tool!;
  const line = () => toolLine(tool(), props.ctx.cwd);
  const list = () => subagentsOf(tool());
  const summary = () => subagentSummary(list());
  return (
    <Line class="py-1">
      <View class="overflow-hidden rounded-lg border border-border">
        <Disclosure
          onPress={() => props.ctx.model.toggle(props.row)}
          label={`Subagent: ${line().object}, ${toolStatusText(tool().status)}${summary() ? `, ${summary()}` : ""}`}
          open={props.row.open}
          class="min-h-9 flex-row items-center gap-2 px-3"
        >
          <Icon name="bot" size={16} tone="muted-foreground" />
          <Text
            class="min-w-0 flex-1 text-sm font-medium text-foreground"
            style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
          >
            {line().object}
          </Text>
          <If when={summary()}>
            <Text class="shrink-0 text-xs text-muted-foreground" style={NUM}>
              {summary()}
            </Text>
          </If>
          <DiffStat added={line().added} removed={line().removed} />
          <ToolStatus status={tool().status} />
          <Icon name={props.row.open ? "chevron-down" : "chevron-right"} size={14} tone="muted-foreground" />
        </Disclosure>
        <If when={linesShown(list(), props.row.open) > 0}>
          <SubagentLines list={list()} cwd={props.ctx.cwd} />
        </If>
        <If when={props.row.open}>
          <View class="px-3 pb-2">
            <ToolDetails
              tool={tool()}
              machine={props.ctx.machine}
              cwd={props.ctx.cwd}
              links={props.ctx.links}
              all={props.row.all}
              onMore={() => props.ctx.model.choose(`more:${props.row.item.id}`, props.row.all)}
            />
          </View>
        </If>
      </View>
    </Line>
  );
}

/** How a notice looks: an error or a failed turn in the failure colour with a mark, a warning with a mark, the rest quiet. */
type Tone = "failed" | "warning";

/** A line from the app or the agent about the session (`Answered: Allow once`): quiet, centred, never folded. */
function NoteRow(props: { text: string; title?: string | null; label: string; tone?: Tone }) {
  tally("row.mount");
  return (
    <Line class="items-center py-1">
      <View role="group" accessibilityLabel={props.label} class="flex-row flex-wrap items-center justify-center gap-2">
        <If when={props.tone}>
          <Icon name="alert" size={12} tone={props.tone === "failed" ? "destructive" : "warning"} />
        </If>
        <If when={props.title}>
          <Text class={`text-xs font-medium ${props.tone === "failed" ? "text-destructive" : "text-foreground"}`}>
            {props.title}
          </Text>
        </If>
        <Text class={`text-xs ${props.tone === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
          {props.text}
        </Text>
      </View>
    </Line>
  );
}

/** The tone a notice's `severity` asks for (`error`, `warning`; anything else is quiet). */
const toneOf = (severity: string | null | undefined): Tone | undefined =>
  severity === "error" ? "failed" : severity === "warning" ? "warning" : undefined;

/** A note's tone: its own severity; a turn that ended in failure (the agent's `done` with `ok` false) is a failure. */
const noteTone = (item: { kind: string; ok?: boolean | null; severity?: string | null }): Tone | undefined =>
  item.kind === "done" ? (item.ok === false ? "failed" : undefined) : toneOf(item.severity);

/** The arrivals of each conversation: one list of seen keys per session model, so a cell asks the list it belongs to. */
const ARRIVALS = new WeakMap<object, Arrivals>();
function arrivedIn(model: SessionModel): Arrivals {
  let list = ARRIVALS.get(model);
  if (!list) {
    list = arrivals(() => untracked(() => model.view()?.running ?? false));
    ARRIVALS.set(model, list);
  }
  return list;
}

/**
 * Rows this close to the end of the conversation can be arrivals. A row further up that a cell shows for the first time
 * was there all along and is only being scrolled to: it must not rise (it did, three a second, scrolling up a long chat).
 */
const ARRIVAL_TAIL = 4;

/**
 * One row of the conversation. The list recycles its cells, so each kind reads its own last row (`ofKind`) and the
 * `If`s decide which one is drawn; nothing here keeps state.
 */
export function SessionRow(props: { row: () => Row; index?: () => number; ctx: RowContext }) {
  const user = ofKind(props.row, "user");
  const agent = ofKind(props.row, "agent");
  const work = ofKind(props.row, "work");
  const calls = ofKind(props.row, "calls");
  const thought = ofKind(props.row, "thought");
  const subagent = ofKind(props.row, "subagent");
  const note = ofKind(props.row, "note");
  const effects = ofKind(props.row, "effects");
  const narration = ofKind(props.row, "narration");
  const earlier = ofKind(props.row, "earlier");
  const other = ofKind(props.row, "other");
  const kind = () => props.row().kind;
  // A line that arrives rises in; the cell is recycled, so this is decided per key, not per cell (`arrivals`), and only
  // for the end of the conversation, where lines arrive.
  const isNew = arrivedIn(props.ctx.model).isNew;
  const atTail = () => props.index === undefined || props.index() >= props.ctx.model.rows().length - ARRIVAL_TAIL;
  const arrival = arriving((key) => {
    const fresh = isNew(key) && untracked(atTail);
    if (fresh) tally("row.rise");
    return fresh;
  });
  tally("row.cell");
  effect(() => {
    tally("row.bind");
    arrival.show(props.row().key);
  });
  return (
    <View style={arrival.style}>
      <If when={kind() === "user"}>
        <UserRow row={user()} ctx={props.ctx} />
      </If>
      <If when={kind() === "agent"}>
        <AgentRow row={agent()} ctx={props.ctx} />
      </If>
      <If when={kind() === "work"}>
        <WorkRow row={work()} model={props.ctx.model} />
      </If>
      <If when={kind() === "narration"}>
        <NarrationRow row={narration()} ctx={props.ctx} />
      </If>
      <If when={kind() === "effects"}>
        <EffectsRow row={effects()} ctx={props.ctx} />
      </If>
      <If when={kind() === "calls"}>
        <CallsBox row={calls()} ctx={props.ctx} />
      </If>
      <If when={kind() === "thought"}>
        <ThoughtRow row={thought()} ctx={props.ctx} />
      </If>
      <If when={kind() === "subagent"}>
        <SubagentRow row={subagent()} ctx={props.ctx} />
      </If>
      <If when={kind() === "note"}>
        <NoteRow
          text={visibleText(note().item.text ?? "")}
          title={note().item.title ? visibleText(note().item.title!) : null}
          label={itemLabel(note().item)}
          tone={noteTone(note().item)}
        />
      </If>
      <If when={kind() === "earlier"}>
        <NoteRow text={earlier().text} label={earlier().text} />
      </If>
      <If when={kind() === "other"}>
        <NoteRow text={visibleText(other().item.text ?? "Update")} label={itemLabel(other().item)} />
      </If>
    </View>
  );
}
