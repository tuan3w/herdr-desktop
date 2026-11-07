import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { Herdr } from "herdr-desktop/native";
import type { BoardCheckout, BoardProject, BoardRow } from "herdr-desktop/native";
import { newSession } from "../lib/actions";
import { reviewWithUndo } from "../lib/herdr";
import { hoverTransition } from "../lib/motion";
import { isSelected, selected } from "../lib/selection";
import { ageText, foldedProjects, moreOpen, projectFolder, projectLabel, projectTitle, QUIET_SHOWN, rowLabel, shownRows, toggleMore, toggleProject } from "../lib/sidebar";
import { AnswerDock } from "./answer-dock";
import { Btn, Clipped, FOCUS_RING, FOCUS_RING_INSET, Icon, NUM, Pill } from "./kit";
import { PickBox } from "./pick-box";
import { Monogram, StateChips } from "./project-parts";
import { StatusGlyph } from "./status-glyph";

/** What a row does when it is opened and what else the home needs to draw it. */
export interface RowProps {
  row: BoardRow;
  project: BoardProject;
  /** Keys of every row in display order, for Shift ranges. */
  order: () => readonly string[];
  /** The agent's question is answered in the `Needs you` strip above, so this row does not repeat the answers. */
  answeredAbove?: boolean;
  onOpen: (row: BoardRow, options?: { reply?: boolean }) => void;
}

/**
 * The picking box shows on hover or focus, and always once anything is picked (so a range can be built without
 * hunting for it); it stays in the accessibility tree and Tab either way.
 */
const pickClass = () => (selected().length > 0 ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100");

/** `claude · hotfix · terminal`: the agent, its checkout when the project has several, and whether it is a chat or a terminal; the strip adds the project in front. */
function detail(row: BoardRow, project: BoardProject, withProject: boolean): string {
  const named = project.checkouts.length > 1 ? project.checkouts.find((c) => c.path === row.checkout)?.name : undefined;
  // The main checkout is called what the project is: saying it twice adds nothing.
  const checkout = named?.toLowerCase() === project.name.toLowerCase() ? undefined : named;
  return [withProject ? project.name : "", row.agent, checkout, row.session ? "chat" : "terminal"].filter(Boolean).join(" · ");
}

/** The part of a row that opens the agent: glyph, name, what it is, how long; a chat adds what the agent said last. */
export function Opener(props: Pick<RowProps, "row" | "project" | "onOpen"> & { withProject?: boolean }) {
  const row = () => props.row;
  return (
    <Button
      onPress={() => props.onOpen(row())}
      selected={isSelected(row().key)}
      accessibilityLabel={rowLabel(row(), props.project.name)}
      style={hoverTransition()}
      class={`min-w-0 flex-1 flex-row items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent selected:bg-accent ${FOCUS_RING_INSET}`}
    >
      <StatusGlyph status={row().status} />
      <View class="min-w-0 flex-1">
        <Clipped class="text-sm font-medium text-foreground">{row().name}</Clipped>
        <Clipped class="text-xs text-muted-foreground">{detail(row(), props.project, props.withProject === true)}</Clipped>
        <If when={row().lastMessage}>{(line) => <Clipped class="text-xs text-muted-foreground">{line()}</Clipped>}</If>
      </View>
      <If when={row().offline}>
        <Pill text="offline" />
      </If>
      <Text style={NUM} class="text-xs text-muted-foreground">
        {ageText(row().sinceSecs)}
      </Text>
    </Button>
  );
}

/**
 * What an agent that needs you asks, under its name: the answers when the question is one the app understands (the one
 * `AnswerDock`, the same behaviour everywhere), else the last rows of its screen so the person can see for themselves,
 * and `Reply…` (opens the pane with the message box). A chat is answered in its own tab, where its permission dock is.
 */
export function Question(props: { row: BoardRow; onOpen: RowProps["onOpen"] }) {
  const row = () => props.row;
  return (
    <If when={!row().session} else={<Text class="px-3 pb-1.5 text-xs font-medium text-signal">Waiting for your answer in the chat</Text>}>
      <View class="gap-2 px-3 pb-1.5">
        <If
          when={row().prompt}
          else={
            <If when={row().preview.length > 0}>
              <Text style={{ userSelect: "text" }} class="font-mono text-xs text-foreground">
                {row().preview.slice(-8).join("\n")}
              </Text>
            </If>
          }
        >
          {(prompt) => <AnswerDock machine={row().machine} pane={row().paneId} prompt={prompt()} />}
        </If>
        <View class="flex-row">
          <Btn small variant="ghost" label="Reply…" name={`Reply…: ${row().name}`} onPress={() => props.onOpen(row(), { reply: true })} />
        </View>
      </View>
    </If>
  );
}

/** One agent of a project: a line, and under it what it asks while it needs you. A machine that is not connected dims it. */
export function AgentRow(props: RowProps) {
  const row = () => props.row;
  const asking = () => row().status === "blocked" && !row().offline;
  return (
    <View class={`group ${row().offline ? "opacity-60" : ""}`}>
      <View class="flex-row items-center gap-1">
        <View class={pickClass()}>
          <PickBox rowKey={row().key} name={row().name} order={props.order} />
        </View>
        <Opener row={props.row} project={props.project} onOpen={props.onOpen} />
        <If when={row().status === "done" && !row().offline}>
          <View class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <Btn small variant="ghost" label="Reviewed" name={`Reviewed: ${row().name}`} onPress={() => reviewWithUndo([row()])} />
          </View>
        </If>
      </View>
      <If when={asking()}>
        <If when={!props.answeredAbove} else={<Text class="px-12 pb-1.5 text-xs text-muted-foreground">Answer it in Needs you, above</Text>}>
          <View class="pl-9">
            <Question row={props.row} onOpen={props.onOpen} />
          </View>
        </If>
      </If>
    </View>
  );
}

/** Whether to show where a project is: the board spans more than one machine. */
export interface CardProps {
  project: BoardProject;
  several: boolean;
  order: () => readonly string[];
  /** Keys of the agents the strip answers. */
  inStrip: () => ReadonlySet<string>;
  onOpen: RowProps["onOpen"];
}

/**
 * A project: its name (a button that folds it), where it lives, what its agents are doing as shape and number chips, the
 * checkouts that have agents, then its agents, those that need you first. A project that needs you has the loud chip in
 * its header and keeps its place: only a pin moves a project. `New agent session in <project>` starts a chat in its folder.
 */
export function ProjectCard(props: CardProps) {
  const p = () => props.project;
  const isFolded = () => foldedProjects().includes(p().key);
  const rows = () => shownRows(p().rows, moreOpen().includes(p().key));
  const quiet = () => p().rows.filter((r) => r.status === "idle" || r.status === "unknown").length;
  const open = () => moreOpen().includes(p().key);
  const worktrees = () => p().checkouts.length > 1 || p().checkouts.some((c) => c.linked);
  return (
    <View role="group" accessibilityLabel={projectLabel(p())} class={`min-w-0 flex-1 gap-1 rounded-lg border border-border bg-card p-2 ${p().offline ? "opacity-60" : ""}`}>
      <View class="group flex-row items-center gap-2">
        <View
          role="button"
          accessibilityLabel={projectTitle(p(), props.several)}
          accessibilityState={{ expanded: !isFolded() }}
          onPress={() => toggleProject(p().key)}
          style={hoverTransition()}
          class={`min-w-0 flex-1 flex-row items-center gap-2 rounded-md py-1 pl-1 pr-2 hover:bg-accent ${FOCUS_RING}`}
        >
          <Icon name={isFolded() ? "chevron-right" : "chevron-down"} size={14} tone="muted-foreground" />
          <Monogram name={p().name} size={24} />
          <Clipped class="shrink text-sm font-semibold text-foreground">{p().name}</Clipped>
          <If when={props.several}>
            <Pill text={p().machineName} />
          </If>
          <If when={p().pinned}>
            <Text class="text-xs text-muted-foreground">Pinned</Text>
          </If>
        </View>
        <StateChips project={p()} />
        <View class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <Btn small variant="ghost" label={p().pinned ? "Unpin" : "Pin"} name={`${p().pinned ? "Unpin" : "Pin"} ${p().name}`} onPress={() => Herdr.pinProject(p().key, !p().pinned)} />
        </View>
      </View>
      <If when={!isFolded()}>
        <If when={worktrees()}>
          <View class="flex-row flex-wrap items-center gap-1.5 px-1 pb-1">
            <Each of={p().checkouts} key={(c: BoardCheckout) => c.path}>
              {(c) => <Pill text={`${c().name} · ${c().linked ? "worktree" : "main"}`} />}
            </Each>
          </View>
        </If>
        <Each of={rows().shown} key={(r: BoardRow) => r.key}>
          {(row) => <AgentRow row={row()} project={p()} order={props.order} answeredAbove={props.inStrip().has(row().key)} onOpen={props.onOpen} />}
        </Each>
        <If when={quiet() > QUIET_SHOWN}>
          <View class="flex-row">
            <View
              role="button"
              onPress={() => toggleMore(p().key)}
              accessibilityLabel={open() ? `Show fewer idle in ${p().name}` : `${quiet() - QUIET_SHOWN} more idle in ${p().name}`}
              accessibilityState={{ expanded: open() }}
              style={hoverTransition()}
              class={`rounded-md px-2 py-1 hover:bg-accent ${FOCUS_RING}`}
            >
              <Text class="text-xs text-muted-foreground">{open() ? "Show fewer idle" : `${quiet() - QUIET_SHOWN} more idle`}</Text>
            </View>
          </View>
        </If>
        <View class="flex-row">
          <Btn
            small
            variant="ghost"
            icon="plus"
            label="New agent session"
            name={`New agent session in ${p().name}`}
            disabled={p().offline}
            onPress={() => newSession({ machine: p().machine, folder: projectFolder(p()) })}
          />
        </View>
      </If>
    </View>
  );
}
