import { Herdr } from "herdr-desktop/native";
import { Text, View } from "nsh";
import { Button } from "nsh/base";

import type { BoardCheckout, BoardProject, BoardRow } from "herdr-desktop/native";

import { AnswerDock } from "#components/answer-dock";
import { PickSlot } from "#components/pick-box";
import { Monogram, ProjectMark } from "#components/project-parts";
import { StatusGlyph } from "#components/status-glyph";
import { Btn, Clipped, FOCUS_RING, FOCUS_RING_INSET, Icon, NUM, Pill } from "#kit";
import { newSession } from "#lib/actions";
import { fromPrompt } from "#lib/ask";
import { openChanges } from "#lib/changes";
import { reviewWithUndo } from "#lib/herdr";
import { GAP, ROW } from "#lib/layout";
import { animateLayout, appear, hoverTransition } from "#lib/motion";
import { openProject } from "#lib/nav";
import { isSelected } from "#lib/selection";
import {
  ageText,
  foldedProjects,
  moreOpen,
  projectFolder,
  projectLabel,
  projectTitle,
  QUIET_SHOWN,
  rowLabel,
  shownRows,
  toggleMore,
  toggleProject,
} from "#lib/sidebar";
import { stateWord } from "#lib/status";

/** What a row does when it is opened and what else the home needs to draw it. */
export interface RowProps {
  row: BoardRow;
  project: BoardProject;
  /** Keys of every row in display order, for Shift ranges. */
  order: () => readonly string[];
  /** `Answer` on a row that waits: opens that agent, where the answer dock is. */
  onAnswer: (row: BoardRow) => void;
  onOpen: (row: BoardRow, options?: { reply?: boolean }) => void;
}

/**
 * `waiting for you · claude · hotfix · terminal`: what the agent is doing in words (a quiet shape says it too, a word
 * does not depend on seeing it), the agent, its checkout when the project has several, and whether it is a chat or a
 * terminal; the inbox adds the project in front and leaves the state out (the inbox is the state).
 */
function detail(row: BoardRow, project: BoardProject, inbox: boolean): string {
  const named = project.checkouts.length > 1 ? project.checkouts.find((c) => c.path === row.checkout)?.name : undefined;
  // The main checkout is called what the project is: saying it twice adds nothing.
  const checkout = named?.toLowerCase() === project.name.toLowerCase() ? undefined : named;
  return [
    inbox ? project.name : stateWord(row.status, row.reviewed),
    row.agent,
    checkout,
    row.session ? "chat" : "terminal",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The part of a row that opens the agent: glyph, name, what it is, how long; a chat adds what the agent said last. `loud` is the inbox's. */
export function Opener(props: Pick<RowProps, "row" | "project" | "onOpen"> & { loud?: boolean }) {
  const row = () => props.row;
  return (
    <Button
      onPress={() => props.onOpen(row())}
      selected={isSelected(row().key)}
      accessibilityLabel={rowLabel(row(), props.project.name)}
      style={hoverTransition()}
      class={`min-w-0 flex-1 flex-row items-center gap-3 rounded-md hover:bg-accent selected:bg-accent ${ROW.agent.class} ${FOCUS_RING_INSET}`}
    >
      <StatusGlyph status={row().status} size={props.loud ? 16 : 12} loud={props.loud} id={row().key} />
      <View class="min-w-0 flex-1">
        <Clipped class="text-sm font-medium text-foreground">{row().name}</Clipped>
        <Clipped class="text-xs text-muted-foreground">{detail(row(), props.project, props.loud === true)}</Clipped>
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
 * What an agent that needs you asks, under its name, in the inbox: the answers when the question is one the app
 * understands (the one `AnswerDock`, the same behaviour everywhere), else the last rows of its screen so the person can see
 * for themselves, and `Reply…` (opens the pane with the message box). A chat is answered in its own tab, where its
 * permission dock is.
 */
export function Question(props: { row: BoardRow; onOpen: RowProps["onOpen"] }) {
  const row = () => props.row;
  return (
    <If
      when={!row().session}
      else={<Text class="pb-2 text-xs text-muted-foreground">Waiting for your answer in the chat</Text>}
    >
      <View class="gap-3 pb-2">
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
          {(prompt) => <AnswerDock inline ask={fromPrompt(prompt(), { machine: row().machine, pane: row().paneId })} />}
        </If>
        <View class="flex-row">
          <Btn
            small
            variant="ghost"
            label="Reply…"
            name={`Reply…: ${row().name}`}
            onPress={() => props.onOpen(row(), { reply: true })}
          />
        </View>
      </View>
    </If>
  );
}

/**
 * One agent of a project: a line. An agent that needs you is said quietly (a small muted shape, `waiting for you` in its
 * meta line) with `Answer` beside it: the question and its chips are in the inbox, never repeated on the card. A machine
 * that is not connected dims it.
 */
export function AgentRow(props: RowProps) {
  const row = () => props.row;
  const asking = () => row().status === "blocked" && !row().offline;
  return (
    <View
      style={appear(row().key)}
      class={`group/row relative flex-row items-center gap-2 pr-1 ${row().offline ? "opacity-60" : ""}`}
    >
      <Opener row={props.row} project={props.project} onOpen={props.onOpen} />
      <If when={asking()}>
        <Btn
          small
          variant="ghost"
          label="Answer"
          name={`Answer: ${row().name}`}
          onPress={() => props.onAnswer(row())}
        />
      </If>
      <If when={row().status === "done" && !row().offline}>
        <View class="opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <Btn
            small
            variant="ghost"
            label="Reviewed"
            name={`Reviewed: ${row().name}`}
            onPress={() => reviewWithUndo([row()])}
          />
        </View>
      </If>
      <PickSlot rowKey={row().key} name={row().name} order={props.order} surface="card" />
    </View>
  );
}

/** Whether to show where a project is: the board spans more than one machine. */
export interface CardProps {
  project: BoardProject;
  several: boolean;
  order: () => readonly string[];
  onAnswer: RowProps["onAnswer"];
  onOpen: RowProps["onOpen"];
  /** Without the fold control (default shown): the card of a project with no tab open is its whole view. */
  fold?: boolean;
}

/**
 * A project: its name (a button that shows the project's workspace) beside a fold control, where it lives, its one aggregate (the signal dot while something waits and
 * the counts in words), the checkouts that have agents, then its agents, those that need you first. A project that needs
 * you keeps its place: only a pin moves a project. `New agent session in <project>` starts a chat in its folder.
 */
export function ProjectCard(props: CardProps) {
  const p = () => props.project;
  const isFolded = () => props.fold !== false && foldedProjects().includes(p().key);
  const rows = () => shownRows(p().rows, moreOpen().includes(p().key));
  const quiet = () => p().rows.filter((r) => r.status === "idle" || r.status === "unknown").length;
  const open = () => moreOpen().includes(p().key);
  const worktrees = () => p().checkouts.length > 1 || p().checkouts.some((c) => c.linked);
  return (
    <View
      role="group"
      accessibilityLabel={projectLabel(p())}
      style={appear(p().key)}
      class={`min-w-0 flex-1 rounded-xl border border-border bg-card p-2 ${GAP.rows} ${p().offline ? "opacity-60" : ""}`}
    >
      <View class="group flex-row items-center gap-3">
        <If when={props.fold !== false}>
          <View
            role="button"
            accessibilityLabel={`${isFolded() ? "Unfold" : "Fold"} ${p().name}`}
            accessibilityState={{ expanded: !isFolded() }}
            onPress={() => {
              animateLayout();
              toggleProject(p().key);
            }}
            style={hoverTransition()}
            class={`size-9 items-center justify-center rounded-md hover:bg-accent ${FOCUS_RING}`}
          >
            <Icon name={isFolded() ? "chevron-right" : "chevron-down"} size={14} tone="muted-foreground" />
          </View>
        </If>
        <View
          role="button"
          accessibilityLabel={projectTitle(p(), props.several)}
          onPress={() => openProject(p().key)}
          style={hoverTransition()}
          class={`min-w-0 flex-1 flex-row items-center gap-3 rounded-md hover:bg-accent ${ROW.project.class} ${FOCUS_RING}`}
        >
          <Monogram name={p().name} size={28} />
          <View class="min-w-0 shrink">
            <Clipped class="text-base font-semibold text-foreground">{p().name}</Clipped>
            <ProjectMark project={p()} decorative />
          </View>
          <If when={props.several}>
            <Pill text={p().machineName} />
          </If>
          <If when={p().pinned}>
            <Text class="text-xs text-muted-foreground">Pinned</Text>
          </If>
        </View>
        <View class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <Btn
            small
            variant="ghost"
            label={p().pinned ? "Unpin" : "Pin"}
            name={`${p().pinned ? "Unpin" : "Pin"} ${p().name}`}
            onPress={() => Herdr.pinProject(p().key, !p().pinned)}
          />
        </View>
      </View>
      <If when={!isFolded()}>
        <If when={worktrees()}>
          <View class="flex-row flex-wrap items-center gap-2 px-3 pb-2">
            <Each of={p().checkouts} key={(c: BoardCheckout) => c.path}>
              {(c) => <Pill text={`${c().name} · ${c().linked ? "worktree" : "main"}`} />}
            </Each>
          </View>
        </If>
        <Each of={rows().shown} key={(r: BoardRow) => r.key}>
          {(row) => (
            <AgentRow row={row()} project={p()} order={props.order} onAnswer={props.onAnswer} onOpen={props.onOpen} />
          )}
        </Each>
        <If when={quiet() > QUIET_SHOWN}>
          <View class="flex-row">
            <View
              role="button"
              onPress={() => {
                animateLayout();
                toggleMore(p().key);
              }}
              accessibilityLabel={
                open() ? `Show fewer idle in ${p().name}` : `${quiet() - QUIET_SHOWN} more idle in ${p().name}`
              }
              accessibilityState={{ expanded: open() }}
              style={hoverTransition()}
              class={`rounded-md hover:bg-accent ${ROW.more.class} justify-center ${FOCUS_RING}`}
            >
              <Text class="text-xs text-muted-foreground">
                {open() ? "Show fewer idle" : `${quiet() - QUIET_SHOWN} more idle`}
              </Text>
            </View>
          </View>
        </If>
        <View class="flex-row px-1 pt-1">
          <Btn
            small
            variant="ghost"
            icon="plus"
            label="New agent session"
            name={`New agent session in ${p().name}`}
            disabled={p().offline}
            onPress={() => newSession({ machine: p().machine, folder: projectFolder(p()) })}
          />
          <Btn
            small
            variant="ghost"
            icon="pencil"
            label="Changes"
            name={`Review changes in ${p().name}`}
            disabled={p().offline || projectFolder(p()) === ""}
            onPress={() => void openChanges(p().machine, projectFolder(p()))}
          />
        </View>
      </If>
    </View>
  );
}
