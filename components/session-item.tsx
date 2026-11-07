import { Clipboard, Image, type JSX, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { ImageView } from "herdr-desktop/native";
import { ofKind } from "../lib/list-item";
import { loadPicture, pictureSize, pictureState } from "../lib/session-pictures";
import type { SessionModel } from "../lib/session";
import type { Row } from "../lib/session-rows";
import { durationText, itemLabel, toolLine, toolStatusText, visibleText, workHead, workParts } from "../lib/session-text";
import { FOCUS_RING, Icon, IconButton, notify } from "./kit";
import { MarkdownText } from "./markdown";
import { DiffStat, Disclosure, PartChips, ToolDetails, ToolRow, ToolStatus } from "./session-tool";

/** The widest a line of the conversation is: past this, text is hard to follow and the window is better left calm. */
const COLUMN = "w-full max-w-[780px] self-center px-4";

/** Where a chat is: what a row needs to open files and to remember what is open. */
export interface RowContext {
  machine: string;
  /** The session's id: pictures of a terminal's log are fetched through it. */
  id: string;
  cwd: string;
  model: SessionModel;
}

function Line(props: { children: JSX.Element; class?: string }) {
  return <View class={`${COLUMN} ${props.class ?? ""}`}>{props.children}</View>;
}

/**
 * A picture in a message of a chat read from a terminal. Nothing is fetched on its own: the line says what it is and what
 * it weighs, and `Load picture` fetches it once. A failure says why and offers `Try again`.
 */
function Picture(props: { image: ImageView; ctx: RowContext }) {
  const state = () => pictureState(props.image.key);
  const loaded = (): string | null => {
    const s = state();
    return s.state === "ready" ? s.uri : null;
  };
  const failed = (): string | null => {
    const s = state();
    return s.state === "failed" ? s.message : null;
  };
  const what = () => ["Picture", pictureSize(props.image.bytes), props.image.mime].filter(Boolean).join(" · ");
  return (
    <View class="items-start gap-1 py-1">
      <If when={loaded()}>
        {(uri) => (
          <Image
            src={uri()}
            accessibilityLabel={`Picture, ${props.image.mime}`}
            style={{ width: 360, height: 220, objectFit: "contain" }}
            class="rounded-lg border border-border"
          />
        )}
      </If>
      <If when={state().state === "idle" || state().state === "failed"}>
        <Button
          onPress={() => void loadPicture(props.ctx.machine, props.ctx.id, props.image)}
          accessibilityLabel={`Load picture, ${what()}`}
          class={`h-8 flex-row items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 hover:bg-accent ${FOCUS_RING}`}
        >
          <Icon name="image" size={14} tone="muted-foreground" />
          <Text class="text-sm text-foreground">{what()}</Text>
          <Text class="text-sm text-muted-foreground">{state().state === "failed" ? "· Try again" : "· Load"}</Text>
        </Button>
      </If>
      <If when={state().state === "loading"}>
        <Text accessibilityState={{ busy: true }} class="text-sm text-muted-foreground">{`Loading picture… ${what()}`}</Text>
      </If>
      <If when={failed()}>
        {(message) => (
          <Text role="alert" class="text-xs text-destructive">
            {message()}
          </Text>
        )}
      </If>
    </View>
  );
}

/** What the person wrote: a rounded bubble on the right; the agent's words are on the page, not in a bubble. */
function UserRow(props: { row: Extract<Row, { kind: "user" }>; ctx: RowContext }) {
  const text = () => visibleText(props.row.item.text ?? "");
  return (
    <Line class="items-end pt-3">
      <View role="group" accessibilityLabel={itemLabel(props.row.item)} class="max-w-[85%] rounded-2xl bg-muted px-3.5 py-2">
        <Text style={{ userSelect: "text" }} class="text-sm text-foreground">
          {text()}
        </Text>
        <Each of={props.row.item.images} key={(i: ImageView) => i.key}>
          {(image) => <Picture image={image()} ctx={props.ctx} />}
        </Each>
        <PartChips parts={props.row.item.parts} machine={props.ctx.machine} cwd={props.ctx.cwd} />
      </View>
    </Line>
  );
}

/** What the agent said, as Markdown on the page. A press-free `Copy message` appears with the pointer or the focus. */
function AgentRow(props: { row: Extract<Row, { kind: "agent" }>; ctx: RowContext }) {
  const source = () => props.row.item.text ?? "";
  return (
    <Line class="group py-1">
      <View role="group" accessibilityLabel={itemLabel(props.row.item)}>
        <MarkdownText source={source()} machine={props.ctx.machine} folder={props.ctx.cwd} streaming={props.row.live} />
        <Each of={props.row.item.images} key={(i: ImageView) => i.key}>
          {(image) => <Picture image={image()} ctx={props.ctx} />}
        </Each>
        <PartChips parts={props.row.item.parts} machine={props.ctx.machine} cwd={props.ctx.cwd} />
      </View>
      <If when={!props.row.live}>
        <View class="absolute right-4 top-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            icon="copy"
            label="Copy message"
            onPress={() => void Clipboard.writeText(source()).then(() => notify("Message copied"))}
          />
        </View>
      </If>
    </Line>
  );
}

/** `Worked for 4s ›`: the header of a group of calls and thoughts; a press opens or folds it. */
function WorkRow(props: { row: Extract<Row, { kind: "work" }>; model: SessionModel }) {
  const work = () => props.row.work;
  const parts = () => workParts(work().summary);
  const head = () => workHead(work());
  return (
    <Line class="pt-1">
      <Disclosure
        onPress={() => props.model.toggle(props.row)}
        label={`${head()}, ${parts().join(", ")}`}
        open={work().open}
        class="-ml-2 min-h-8 flex-row items-center gap-1.5 self-start rounded-md px-2"
      >
        <Icon name={work().open ? "chevron-down" : "chevron-right"} size={14} tone="muted-foreground" />
        <Text class="text-sm text-muted-foreground">{head()}</Text>
        <Text class={`text-xs ${work().summary.failed > 0 ? "text-destructive" : "text-muted-foreground"}`}>{`· ${parts().join(" · ")}`}</Text>
      </Disclosure>
    </Line>
  );
}

/** One thought, a line that opens to what the agent reasoned. */
function ThoughtRow(props: { row: Extract<Row, { kind: "thought" }>; ctx: RowContext }) {
  const label = () => (props.row.seconds === null ? "Thought" : `Thought for ${durationText(props.row.seconds)}`);
  return (
    <Line>
      <Disclosure
        onPress={() => props.ctx.model.toggle(props.row)}
        label={label()}
        open={props.row.open}
        class="-ml-2 min-h-7 flex-row items-center gap-2 self-start rounded-md px-2"
      >
        <Icon name="lightbulb" size={14} tone="muted-foreground" />
        <Text class="text-sm text-muted-foreground">{label()}</Text>
        <Icon name={props.row.open ? "chevron-down" : "chevron-right"} size={12} tone="muted-foreground" />
      </Disclosure>
      <If when={props.row.open}>
        <View class="ml-4 border-l border-border pl-3">
          <MarkdownText source={props.row.item.text ?? ""} machine={props.ctx.machine} folder={props.ctx.cwd} class="text-muted-foreground" />
        </View>
      </If>
    </Line>
  );
}

/** A call, folded into its line, open to its details. */
function ToolEntry(props: { row: Extract<Row, { kind: "tool" }>; ctx: RowContext }) {
  const tool = () => props.row.item.tool!;
  return (
    <Line>
      <ToolRow tool={tool()} cwd={props.ctx.cwd} open={props.row.open} onToggle={() => props.ctx.model.toggle(props.row)} />
      <If when={props.row.open}>
        <ToolDetails
          tool={tool()}
          machine={props.ctx.machine}
          cwd={props.ctx.cwd}
          all={props.row.all}
          onMore={() => props.ctx.model.choose(`more:${props.row.item.id}`, props.row.all)}
        />
      </If>
    </Line>
  );
}

/** A call that started another agent: a bordered line with its state, outside the fold, open to what it handed back. */
function SubagentRow(props: { row: Extract<Row, { kind: "subagent" }>; ctx: RowContext }) {
  const tool = () => props.row.item.tool!;
  const line = () => toolLine(tool(), props.ctx.cwd);
  return (
    <Line class="py-0.5">
      <View class="rounded-lg border border-border">
        <Disclosure
          onPress={() => props.ctx.model.toggle(props.row)}
          label={`Subagent: ${line().object}, ${toolStatusText(tool().status)}`}
          open={props.row.open}
          class="min-h-9 flex-row items-center gap-2 rounded-lg px-3"
        >
          <Icon name="bot" size={16} tone="muted-foreground" />
          <Text class="min-w-0 flex-1 text-sm font-medium text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {line().object}
          </Text>
          <DiffStat added={line().added} removed={line().removed} />
          <ToolStatus status={tool().status} />
          <Icon name={props.row.open ? "chevron-down" : "chevron-right"} size={14} tone="muted-foreground" />
        </Disclosure>
        <If when={props.row.open}>
          <View class="px-3 pb-2">
            <ToolDetails
              tool={tool()}
              machine={props.ctx.machine}
              cwd={props.ctx.cwd}
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
  return (
    <Line class="items-center py-1">
      <View role="group" accessibilityLabel={props.label} class="flex-row flex-wrap items-center justify-center gap-1.5">
        <If when={props.tone}>
          <Icon name="alert" size={12} tone={props.tone === "failed" ? "destructive" : "warning"} />
        </If>
        <If when={props.title}>
          <Text class={`text-xs font-medium ${props.tone === "failed" ? "text-destructive" : "text-foreground"}`}>{props.title}</Text>
        </If>
        <Text class={`text-xs ${props.tone === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{props.text}</Text>
      </View>
    </Line>
  );
}

/** The tone a notice's `severity` asks for (`error`, `warning`; anything else is quiet). */
const toneOf = (severity: string | null | undefined): Tone | undefined => (severity === "error" ? "failed" : severity === "warning" ? "warning" : undefined);

/**
 * One row of the conversation. The list recycles its cells, so each kind reads its own last row (`ofKind`) and the
 * `If`s decide which one is drawn; nothing here keeps state.
 */
export function SessionRow(props: { row: () => Row; ctx: RowContext }) {
  const user = ofKind(props.row, "user");
  const agent = ofKind(props.row, "agent");
  const work = ofKind(props.row, "work");
  const tool = ofKind(props.row, "tool");
  const thought = ofKind(props.row, "thought");
  const subagent = ofKind(props.row, "subagent");
  const note = ofKind(props.row, "note");
  const done = ofKind(props.row, "done");
  const earlier = ofKind(props.row, "earlier");
  const other = ofKind(props.row, "other");
  const kind = () => props.row().kind;
  return (
    <>
      <If when={kind() === "user"}>
        <UserRow row={user()} ctx={props.ctx} />
      </If>
      <If when={kind() === "agent"}>
        <AgentRow row={agent()} ctx={props.ctx} />
      </If>
      <If when={kind() === "work"}>
        <WorkRow row={work()} model={props.ctx.model} />
      </If>
      <If when={kind() === "tool"}>
        <ToolEntry row={tool()} ctx={props.ctx} />
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
          tone={toneOf(note().item.severity)}
        />
      </If>
      <If when={kind() === "done"}>
        <NoteRow text={visibleText(done().item.text ?? "")} label={itemLabel(done().item)} tone={done().item.ok === false ? "failed" : undefined} />
      </If>
      <If when={kind() === "earlier"}>
        <NoteRow text={earlier().text} label={earlier().text} />
      </If>
      <If when={kind() === "other"}>
        <NoteRow text={visibleText(other().item.text ?? "Update")} label={itemLabel(other().item)} />
      </If>
    </>
  );
}
