import { Clipboard, Image, type JSX, Text, View } from "nsh";
import { Button, DiffView } from "nsh/base";
import type { DiffItem, LocationView, PartView, ToolItem, ToolStatusName } from "herdr-desktop/native";
import { viewFile } from "../lib/files";
import { pictureSize } from "../lib/session-pictures";
import { hoverTransition } from "../lib/motion";
import { outputView, shortPath, toolIcon, toolKindOf, toolLine, toolStatusText, visibleText } from "../lib/session-text";
import { FOCUS_RING, FOCUS_RING_INSET, Icon, IconButton, notify } from "./kit";
import { openLink } from "./links-dialog";
import { StatusGlyph } from "./status-glyph";

/** Lines of a call's input shown before it is cut. */
const INPUT_LINES = 12;

const copy = (text: string, done: string) => void Clipboard.writeText(text).then(() => notify(done));

/**
 * A row that opens and folds something under it. It is a view with the button role rather than a `Button`, because only a
 * view can say `expanded` to a screen reader (`Button` has `selected`, which would read as "selected"). Enter and Space
 * press it like any press target, and it is a stop of the keyboard focus.
 */
export function Disclosure(props: { label: string; open: boolean; onPress: () => void; class?: string; children?: JSX.Element }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ expanded: props.open }}
      onPress={props.onPress}
      style={hoverTransition()}
      class={`${props.class ?? ""} hover:bg-accent ${FOCUS_RING_INSET}`}
    >
      {props.children}
    </View>
  );
}

/** A call's state as a shape: waiting is a dashed ring, running a half ring, done a quiet check, failed a cross. */
export function ToolStatus(props: { status: ToolStatusName }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" class="size-4 shrink-0 items-center justify-center">
      <If when={props.status === "completed"}>
        <Icon name="check" size={14} tone="muted-foreground" />
      </If>
      <If when={props.status === "failed"}>
        <Icon name="x" size={14} tone="destructive" />
      </If>
      <If when={props.status === "inProgress"}>
        <StatusGlyph status="working" size={12} />
      </If>
      <If when={props.status === "pending"}>
        <StatusGlyph status="unknown" size={12} />
      </If>
    </View>
  );
}

/** `+6 −2`, in words a screen reader can say (`6 added, 2 removed`); nothing for a call that changed nothing. */
export function DiffStat(props: { added: number; removed: number }) {
  return (
    <If when={props.added > 0 || props.removed > 0}>
      <Text accessibilityLabel={`${props.added} added, ${props.removed} removed`} class="shrink-0 font-mono text-xs">
        <Text class="text-success">{`+${props.added}`}</Text>
        <Text class="text-destructive">{` −${props.removed}`}</Text>
      </Text>
    </If>
  );
}

/**
 * One tool call as one quiet line: the kind's icon, a verb, what it acted on in monospace, the size of an edit, a state
 * shape. A press opens its details (`ToolDetails`). The row is a button named by what it says and whether it is open.
 */
export function ToolRow(props: { tool: ToolItem; cwd: string; open: boolean; onToggle: () => void }) {
  const line = () => toolLine(props.tool, props.cwd);
  const said = () => [line().verb, line().object].filter(Boolean).join(" ");
  return (
    <Disclosure
      onPress={props.onToggle}
      label={`Tool: ${said()}, ${toolStatusText(props.tool.status)}`}
      open={props.open}
      class="min-h-8 flex-row items-center gap-2 rounded-md px-2 py-1"
    >
      <Icon name={toolIcon(line().kind)} size={14} tone="muted-foreground" />
      <Text class="min-w-0 flex-1 text-sm text-muted-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
        <If when={line().verb}>
          <Text class="text-muted-foreground">{`${line().verb} `}</Text>
        </If>
        <Text class={line().verb ? "font-mono text-xs text-foreground" : "text-sm text-foreground"}>{line().object}</Text>
      </Text>
      <DiffStat added={line().added} removed={line().removed} />
      <ToolStatus status={props.tool.status} />
    </Disclosure>
  );
}

/** A block of selectable monospace text with a copy button that appears with the pointer and stays pressable. */
function Mono(props: { text: string; label: string; copied: string }) {
  return (
    <View class="group rounded-md bg-muted px-3 py-2">
      <Text style={{ userSelect: "text" }} class="font-mono text-xs text-foreground">
        {props.text}
      </Text>
      <View class="absolute right-1 top-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton icon="copy" label={props.label} onPress={() => copy(props.text, props.copied)} />
      </View>
    </View>
  );
}

/** What one edit looks like: the file (a link to it in the viewer), the size, then the change itself. */
function Edit(props: { diff: DiffItem; machine: string; cwd: string }) {
  // The rows a unified diff draws: at most the new text plus what was removed, and with three lines of context around
  // each change usually fewer. A guess that errs high leaves blank space, one that errs low scrolls: so the smaller of two.
  const rows = () => {
    const lines = props.diff.new.split("\n").length + props.diff.removed;
    return Math.min(300, Math.max(54, Math.min(lines, props.diff.added + props.diff.removed + 7) * 18 + 4));
  };
  return (
    <View class="gap-1">
      <View class="flex-row items-center gap-2">
        <Button
          onPress={() => viewFile(props.machine, props.diff.path)}
          accessibilityLabel={`Open ${shortPath(props.diff.path, props.cwd)}`}
          class={`min-w-0 flex-1 flex-row items-center gap-2 rounded-md py-1 ${FOCUS_RING}`}
        >
          <Icon name="file" size={12} tone="muted-foreground" />
          <Text class="min-w-0 font-mono text-xs text-foreground underline" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {shortPath(props.diff.path, props.cwd)}
          </Text>
        </Button>
        <If when={props.diff.old == null}>
          <Text class="text-xs text-muted-foreground">new file</Text>
        </If>
        <DiffStat added={props.diff.added} removed={props.diff.removed} />
      </View>
      <View role="group" accessibilityLabel={`Changes to ${shortPath(props.diff.path, props.cwd)}`} style={{ height: rows() }} class="overflow-hidden rounded-md border border-border">
        <DiffView
          oldValue={props.diff.old ?? ""}
          newValue={props.diff.new}
          language={props.diff.path}
          layout="unified"
          fontSize={12}
          lineHeight={18}
          contextLines={3}
          class="flex-1"
        />
      </View>
    </View>
  );
}

/** The path a `file:` address names on the agent's machine, or `null` for any other address. */
const pathOf = (uri: string | null | undefined): string | null => {
  if (!uri || !uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
};

/**
 * What a message or a tool call carries besides text: a small picture is drawn (at most 220 pt tall), a bigger one, a
 * sound and a file are a chip with the name and size. A file on the machine opens in the viewer, a web address in the
 * browser; nothing is fetched on its own. The agent's sound is not played: nothing in this app plays sound unasked.
 */
export function PartChips(props: { parts: readonly PartView[]; machine: string; cwd: string }) {
  return (
    <Each of={props.parts as PartView[]} key="index">
      {(part) => {
        const path = () => pathOf(part().uri);
        const drawn = () => (part().partKind === "image" && part().data ? `data:${part().mime ?? "image/png"};base64,${part().data}` : null);
        const detail = () => [part().partKind === "audio" ? "Sound" : part().partKind === "image" ? "Picture" : "", pictureSize(part().size)].filter(Boolean).join(" · ");
        const press = () => {
          const p = path();
          if (p) viewFile(props.machine, p);
          else if (part().uri && /^https?:\/\//i.test(part().uri!)) void openLink("url", part().uri!, null, null, { machine: props.machine, cwd: props.cwd });
        };
        return (
          <View class="items-start py-1">
            <If when={drawn()}>
              {(src) => (
                <Image
                  src={src()}
                  accessibilityLabel={`Picture, ${part().name}`}
                  style={{ width: 320, height: 200, objectFit: "contain" }}
                  class="rounded-lg border border-border"
                />
              )}
            </If>
            <If when={!drawn()}>
              <Button
                onPress={press}
                disabled={!path() && !(part().uri && /^https?:\/\//i.test(part().uri!))}
                accessibilityLabel={`${part().partKind === "audio" ? "Sound" : part().partKind === "image" ? "Picture" : "File"}: ${part().name}${detail() ? `, ${detail()}` : ""}`}
                class={`h-9 max-w-[360px] flex-row items-center gap-2 rounded-md border border-border bg-muted px-3 hover:bg-accent ${FOCUS_RING}`}
              >
                <Icon name={part().partKind === "image" ? "image" : "file"} size={14} tone="muted-foreground" />
                <Text class="min-w-0 text-sm text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
                  {part().name}
                </Text>
                <If when={detail()}>
                  <Text class="shrink-0 text-xs text-muted-foreground">{detail()}</Text>
                </If>
              </Button>
            </If>
          </View>
        );
      }}
    </Each>
  );
}

/** The files a call touched as `path:line`, four of them and then `+N more`; a press opens the file at the line. */
function Locations(props: { locations: readonly LocationView[]; machine: string; cwd: string; all: boolean }) {
  const shown = () => (props.all ? props.locations : props.locations.slice(0, 4));
  return (
    <View role="list" accessibilityLabel="Files it touched" class="gap-1">
      <Each of={shown() as LocationView[]} key="index">
        {(loc) => (
          <Button
            onPress={() => viewFile(props.machine, loc().path, loc().line)}
            accessibilityLabel={`Open ${shortPath(loc().path, props.cwd)}${loc().line ? ` at line ${loc().line}` : ""}`}
            class={`flex-row items-center gap-2 self-start rounded-md py-1 ${FOCUS_RING}`}
          >
            <Icon name="file" size={12} tone="muted-foreground" />
            <Text class="font-mono text-xs text-foreground underline">{`${shortPath(loc().path, props.cwd)}${loc().line ? `:${loc().line}` : ""}`}</Text>
          </Button>
        )}
      </Each>
      <If when={!props.all && props.locations.length > 4}>
        <Text class="text-xs text-muted-foreground">{`+${props.locations.length - 4} more`}</Text>
      </If>
    </View>
  );
}

/**
 * Behind a tool row: the command whole (what the agent ran is read in full, never cut), the edits as diffs, and the
 * output, a few lines first and `Show all N lines` for the rest. The agent keeps the first and the last lines of an
 * output; a gap between them says `N lines not kept`.
 */
export function ToolDetails(props: { tool: ToolItem; machine: string; cwd: string; all: boolean; onMore: () => void }) {
  const output = () => outputView(props.tool, props.all);
  const text = () => {
    const o = output();
    return o.omitted > 0 && o.lines.length > 1
      ? [...o.lines.slice(0, props.tool.head.length), `… ${o.omitted} lines not kept …`, ...o.lines.slice(props.tool.head.length)].join("\n")
      : o.lines.join("\n");
  };
  const subject = () => visibleText(props.tool.subject ?? "");
  const showSubject = () => subject() !== "" && props.tool.diffs.length === 0;
  const total = () => output().lines.length + output().hidden;
  // What the agent sent the tool, for a call whose subject does not already say it (a command's input is the command).
  const inputText = () => {
    const input = props.tool.input;
    if (!input || toolKindOf(props.tool) === "execute") return "";
    const lines = visibleText(input).split("\n");
    return lines.length > INPUT_LINES ? `${lines.slice(0, INPUT_LINES).join("\n")}\n… ${lines.length - INPUT_LINES} more lines` : lines.join("\n");
  };
  const ended = () => {
    const { exitCode, exitSignal, cwd } = props.tool;
    const how = exitSignal ? `Ended by ${exitSignal}` : exitCode != null ? `Exit code ${exitCode}` : "";
    return [cwd && cwd !== props.cwd ? `In ${cwd}` : "", how].filter(Boolean).join(" · ");
  };
  return (
    <View class="ml-4 mb-1 gap-2 border-l border-border pl-3 pt-1">
      <If when={showSubject()}>
        <Mono text={subject()} label="Copy command" copied="Command copied" />
      </If>
      <If when={props.tool.locations.length > 0 && props.tool.diffs.length === 0}>
        <Locations locations={props.tool.locations} machine={props.machine} cwd={props.cwd} all={props.all} />
      </If>
      <Each of={props.tool.diffs} key="index">
        {(diff) => <Edit diff={diff()} machine={props.machine} cwd={props.cwd} />}
      </Each>
      <If when={inputText() !== ""}>
        <View class="gap-1">
          <Text class="text-xs text-muted-foreground">Input</Text>
          <Mono text={inputText()} label="Copy input" copied="Input copied" />
        </View>
      </If>
      <PartChips parts={props.tool.parts} machine={props.machine} cwd={props.cwd} />
      <If when={output().lines.length > 0}>
        <Mono text={text()} label="Copy output" copied="Output copied" />
        <If when={output().hidden > 0}>
          <Button
            onPress={props.onMore}
            accessibilityLabel={`Show all ${total()} lines of output`}
            class={`self-start rounded-md px-2 py-1 hover:bg-accent ${FOCUS_RING}`}
          >
            <Text class="text-xs text-muted-foreground">{`Show all ${total()} lines`}</Text>
          </Button>
        </If>
      </If>
      <If when={ended()}>
        <Text class={`font-mono text-xs ${props.tool.exitCode || props.tool.exitSignal ? "text-destructive" : "text-muted-foreground"}`}>{ended()}</Text>
      </If>
      <If when={output().lines.length === 0 && props.tool.diffs.length === 0 && !showSubject() && inputText() === ""}>
        <Text class="text-xs text-muted-foreground">{props.tool.status === "pending" || props.tool.status === "inProgress" ? "No output yet" : "No output"}</Text>
      </If>
    </View>
  );
}
