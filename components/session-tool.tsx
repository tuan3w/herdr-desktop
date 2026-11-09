import { Image, type JSX, Scroll, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { DiffItem, LocationView, PartView, ToolItem, ToolStatusName } from "herdr-desktop/native";
import type { ScrollRef } from "nsh/types";

import { CodeBlock } from "#components/code-block";
import { DiffBlock } from "#components/diff-block";
import { openLink } from "#components/open-link";
import { StatusGlyph } from "#components/status-glyph";
import { FOCUS_RING, FOCUS_RING_INSET, Icon } from "#kit";
import type { LinkPanel } from "#lib/link-panel";
import { pathOfUri } from "#lib/message-files";
import { hoverTransition } from "#lib/motion";
import { pictureSize } from "#lib/session-pictures";
import {
  OUTPUT_LINES,
  outputFromEnd,
  outputView,
  shortPath,
  toolKindOf,
  toolLine,
  visibleText,
} from "#lib/session-text";
import { OUT_LINE_PT } from "#lib/transcript-scroll";

/** Where a call's paths are and where a press on one opens: found as a message's link is, in the chat's side panel. */
interface PathContext {
  machine: string;
  cwd: string;
  links?: LinkPanel;
}

/** Opens a path a call named, relative or not, at its line: the side panel when the chat has one, else the viewer. */
const openPath = (at: PathContext, path: string, line?: number | null): void =>
  void openLink("path", path, line, null, { machine: at.machine, cwd: at.cwd, panel: at.links });

/** Lines of a call's input shown before it is cut. */
const INPUT_LINES = 12;
/** How tall a command's output or an edit grows inside a tool row before it scrolls: the row is a step, not the page. */
const TOOL_BLOCK_HEIGHT = 360;

/**
 * A row that opens and folds something under it. It is a view with the button role rather than a `Button`, because only a
 * view can say `expanded` to a screen reader (`Button` has `selected`, which would read as "selected"). Enter and Space
 * press it like any press target, and it is a stop of the keyboard focus.
 */
export function Disclosure(props: {
  label: string;
  open: boolean;
  onPress: () => void;
  class?: string;
  children?: JSX.Element;
}) {
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

/**
 * A call's state, said only when it is an exception: waiting is a dashed ring, running a half ring, failed the word
 * `Failed` in red. A call that finished well draws nothing: success is silence, and the folded line already counts it.
 */
export function ToolStatus(props: { status: ToolStatusName }) {
  return (
    <>
      <If when={props.status === "failed"}>
        <Text accessibilityElementsHidden class="shrink-0 text-sm text-destructive">
          Failed
        </Text>
      </If>
      <If when={props.status === "inProgress" || props.status === "pending"}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          class="size-4 shrink-0 items-center justify-center"
        >
          <If when={props.status === "inProgress"}>
            <StatusGlyph status="working" size={12} />
          </If>
          <If when={props.status === "pending"}>
            <StatusGlyph status="unknown" size={12} />
          </If>
        </View>
      </If>
    </>
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

/** What one edit looks like: the file's change as a diff, its name a link to the file (the side panel, else the viewer). */
function Edit(props: { diff: DiffItem; at: PathContext }) {
  return (
    <DiffBlock
      path={shortPath(props.diff.path, props.at.cwd)}
      oldText={props.diff.old ?? ""}
      newText={props.diff.new}
      created={props.diff.old == null}
      flat
      context={3}
      maxHeight={TOOL_BLOCK_HEIGHT}
      onOpenFile={() => openPath(props.at, props.diff.path)}
    />
  );
}

/**
 * What a message or a tool call carries besides text: a small picture is drawn (at most 220 pt tall), a bigger one, a
 * sound and a file are a chip with the name and size. A file on the machine and a web address open in the chat's side
 * panel (`links`), else the viewer and the browser; nothing is fetched on its own. The agent's sound is not played:
 * nothing in this app plays sound unasked.
 */
export function PartChips(props: { parts: readonly PartView[]; machine: string; cwd: string; links?: LinkPanel }) {
  return (
    <Each of={props.parts as PartView[]} key="index">
      {(part) => {
        const path = () => pathOfUri(part().uri);
        const drawn = () =>
          part().partKind === "image" && part().data
            ? `data:${part().mime ?? "image/png"};base64,${part().data}`
            : null;
        const detail = () =>
          [
            part().partKind === "audio" ? "Sound" : part().partKind === "image" ? "Picture" : "",
            pictureSize(part().size),
          ]
            .filter(Boolean)
            .join(" · ");
        const press = () => {
          const p = path();
          if (p) openPath(props, p);
          else if (part().uri && /^https?:\/\//i.test(part().uri!))
            void openLink("url", part().uri!, null, null, { machine: props.machine, panel: props.links });
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
function Locations(props: { locations: readonly LocationView[]; at: PathContext; all: boolean }) {
  const shown = () => (props.all ? props.locations : props.locations.slice(0, 4));
  return (
    <View role="list" accessibilityLabel="Files it touched" class="gap-1">
      <Each of={shown() as LocationView[]} key="index">
        {(loc) => (
          <Button
            onPress={() => openPath(props.at, loc().path, loc().line)}
            accessibilityLabel={`Open ${shortPath(loc().path, props.at.cwd)}${loc().line ? ` at line ${loc().line}` : ""}`}
            class={`flex-row items-center gap-2 self-start rounded-md py-1 ${FOCUS_RING}`}
          >
            <Icon name="file" size={12} tone="muted-foreground" />
            <Text class="font-mono text-xs text-foreground underline">{`${shortPath(loc().path, props.at.cwd)}${loc().line ? `:${loc().line}` : ""}`}</Text>
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
 * What a call printed, as plain mono lines, never boxed. Past `OUTPUT_LINES` it scrolls inside itself: it is cut a
 * half line past the last of them, so the part of a line at the edge says there is more, and it starts at the end for a
 * command (how it ended is at the bottom) and at the top for a read.
 */
function Output(props: { text: string; lines: number; fromEnd: boolean }) {
  let scroll: ScrollRef | undefined;
  let placed = false;
  const body = (
    <Text class="font-mono text-xs text-muted-foreground" style={{ userSelect: "text" }}>
      {props.text}
    </Text>
  );
  return (
    <If when={props.lines > OUTPUT_LINES} else={body}>
      <Scroll
        ref={(node: ScrollRef) => {
          scroll = node;
        }}
        accessibilityLabel={`Output, ${props.lines} lines`}
        style={{ maxHeight: (OUTPUT_LINES + 0.5) * OUT_LINE_PT }}
      >
        <View
          onLayout={({ bounds }) => {
            // Once: a later layout is the output growing under a person who may be reading its top.
            if (placed || !props.fromEnd) return;
            placed = true;
            scroll?.scrollTo({ y: bounds.size.height, animated: false });
          }}
        >
          {body}
        </View>
      </Scroll>
    </If>
  );
}

/**
 * Behind a tool row: the command whole (what the agent ran is read in full, never cut), the edits as diffs, and the
 * output (`Output`). The agent keeps the first and the last lines of an output; a gap between them says
 * `N lines not kept`. A path it names opens as a message's link does, in `links`.
 */
export function ToolDetails(props: {
  tool: ToolItem;
  machine: string;
  cwd: string;
  links?: LinkPanel;
  all: boolean;
  onMore: () => void;
}) {
  const output = () => outputView(props.tool);
  const text = () => {
    const o = output();
    return o.omitted > 0 && o.lines.length > 1
      ? [
          ...o.lines.slice(0, props.tool.head.length),
          `… ${o.omitted} lines not kept …`,
          ...o.lines.slice(props.tool.head.length),
        ].join("\n")
      : o.lines.join("\n");
  };
  const subject = () => visibleText(props.tool.subject ?? "");
  // The step line says what the call was for, not what it ran: a command is always shown whole when its step is open.
  const showSubject = () =>
    props.tool.diffs.length === 0 &&
    subject() !== "" &&
    (toolKindOf(props.tool) === "execute" || subject().includes("\n") || subject() !== toolLine(props.tool).object);
  // The row shows a short path; the whole one is a caption under it, only for a call that acted on a file and shows no
  // diff (a diff carries its own path as its header).
  const fullPath = () => {
    const kind = toolKindOf(props.tool);
    if (props.tool.diffs.length > 0) return "";
    const path = kind === "read" || kind === "edit" ? subject() : "";
    return path && path !== toolLine(props.tool, props.cwd).object ? path : "";
  };
  // What the agent sent the tool, for a call whose subject does not already say it (a command's input is the command).
  const inputText = () => {
    const input = props.tool.input;
    if (!input || toolKindOf(props.tool) === "execute") return "";
    const lines = visibleText(input).split("\n");
    return lines.length > INPUT_LINES
      ? `${lines.slice(0, INPUT_LINES).join("\n")}\n… ${lines.length - INPUT_LINES} more lines`
      : lines.join("\n");
  };
  const ended = () => {
    const { exitCode, exitSignal, cwd } = props.tool;
    const how = exitSignal ? `Ended by ${exitSignal}` : exitCode != null ? `Exit code ${exitCode}` : "";
    return [cwd && cwd !== props.cwd ? `In ${cwd}` : "", how].filter(Boolean).join(" · ");
  };
  return (
    <View class="gap-3">
      <If when={fullPath()}>
        <Text
          class="font-mono text-xs text-muted-foreground"
          style={{ numberOfLines: 1, textOverflow: "ellipsis", userSelect: "text" }}
        >
          {fullPath()}
        </Text>
      </If>
      <If when={showSubject()}>
        <CodeBlock code={subject()} language="bash" compact flat collapsedLines={0} maxHeight={TOOL_BLOCK_HEIGHT} />
      </If>
      <If when={props.tool.locations.length > 0 && props.tool.diffs.length === 0}>
        <Locations
          locations={props.tool.locations}
          at={{ machine: props.machine, cwd: props.cwd, links: props.links }}
          all={props.all}
        />
      </If>
      <Each of={props.tool.diffs} key="index">
        {(diff) => <Edit diff={diff()} at={{ machine: props.machine, cwd: props.cwd, links: props.links }} />}
      </Each>
      <If when={inputText() !== ""}>
        <CodeBlock code={inputText()} compact flat collapsedLines={0} maxHeight={TOOL_BLOCK_HEIGHT} />
      </If>
      <PartChips parts={props.tool.parts} machine={props.machine} cwd={props.cwd} links={props.links} />
      {/* How it ended sits under what ran and above what it printed, so it is read as that command's. */}
      <If when={ended()}>
        <Text
          class={`font-mono text-xs ${props.tool.exitCode || props.tool.exitSignal ? "text-warning" : "text-muted-foreground"}`}
        >
          {ended()}
        </Text>
      </If>
      <If when={output().lines.length > 0}>
        <Output
          text={text()}
          lines={output().lines.length + (output().omitted > 0 ? 1 : 0)}
          fromEnd={outputFromEnd(props.tool)}
        />
      </If>
      <If when={output().lines.length === 0 && props.tool.diffs.length === 0 && !showSubject() && inputText() === ""}>
        <Text class="text-xs text-muted-foreground">
          {props.tool.status === "pending" || props.tool.status === "inProgress" ? "No output yet" : "No output"}
        </Text>
      </If>
    </View>
  );
}
