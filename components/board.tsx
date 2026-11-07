import { computed, Scroll, signal, Text, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import type { BoardProject, BoardRow } from "herdr-desktop/native";
import { allRows, board, projectOf, revision, reviewable } from "../lib/herdr";
import { hoverTransition } from "../lib/motion";
import { select } from "../lib/selection";
import { type HomeLine, homeLines, strip, TWO_COLUMNS_FROM } from "../lib/board-items";
import { foldedProjects, moreOpen, shownRows } from "../lib/sidebar";
import { Opener, ProjectCard, Question } from "./board-card";
import { Btn, Empty, FOCUS_RING, NUM } from "./kit";
import { StatusGlyph } from "./status-glyph";
import { Triage } from "./triage";

/**
 * The status line, one count for every surface: only the needs-you words are loud, and `3 to review` is a button that
 * picks exactly those agents (and opens the projects that were folded over them) for the bulk bar's `Reviewed`.
 */
function StatusLine() {
  const parts = computed(() => board().statusLine.split(" · "));
  const pickToReview = () => {
    const finished = reviewable(allRows(board()));
    select(finished.map((r) => r.key));
    const where = new Set(finished.map((r) => r.project));
    foldedProjects.update((all) => all.filter((k) => !where.has(k)));
  };
  return (
    <View class="flex-row flex-wrap items-center gap-x-1.5 px-1">
      <Each of={parts()} key="index">
        {(part, i) => (
          <View class="flex-row items-center gap-1.5">
            <If when={i() > 0}>
              <Text class="text-sm text-muted-foreground">·</Text>
            </If>
            <If
              when={/^\d+ to review/.test(part())}
              else={
                <Text style={NUM} class={`text-sm ${/^\d+ need(s)? you/.test(part()) ? "font-medium text-signal" : "text-muted-foreground"}`}>
                  {part()}
                </Text>
              }
            >
              <View
                role="button"
                accessibilityLabel={`${part()}, select them`}
                onPress={pickToReview}
                style={hoverTransition()}
                class={`rounded-md px-1 hover:bg-accent ${FOCUS_RING}`}
              >
                <Text style={NUM} class="text-sm text-muted-foreground underline">
                  {part()}
                </Text>
              </View>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

/**
 * The inbox over the projects: the agents that wait for an answer, longest first, each with its question and the one
 * `AnswerDock`. Three at most, so the projects stay in view; the rest are one `Answer one by one` away. It exists only
 * while something waits, takes no room otherwise and does not animate.
 */
function NeedsYou(props: { onTriage: () => void; onOpen: (row: BoardRow, options?: { reply?: boolean }) => void }) {
  const waiting = computed(() => strip(board()));
  return (
    <If when={waiting().rows.length > 0}>
      <View role="group" accessibilityLabel="Needs you" class="gap-1 rounded-lg border border-border bg-card p-2">
        <View class="min-h-8 flex-row items-center justify-between px-1">
          <View class="flex-row items-center gap-2">
            <StatusGlyph status="blocked" />
            <Text role="header" class="text-sm font-semibold text-signal">
              Needs you
            </Text>
          </View>
          <If when={board().counts.needsYou > 1}>
            <Btn small label="Answer one by one" onPress={props.onTriage} />
          </If>
        </View>
        <Each of={waiting().rows} key={(r: BoardRow) => r.key}>
          {(row) => (
            <If when={projectOf(row().project)}>
              {(project) => (
                <View class="gap-0.5">
                  <View class="flex-row items-center">
                    <Opener row={row()} project={project()} withProject onOpen={props.onOpen} />
                  </View>
                  <View class="pl-8">
                    <Question row={row()} onOpen={props.onOpen} />
                  </View>
                </View>
              )}
            </If>
          )}
        </Each>
        <If when={waiting().more > 0}>
          <Text class="px-2 pb-1 text-xs text-muted-foreground">{`${waiting().more} more waiting`}</Text>
        </If>
      </View>
    </If>
  );
}

/**
 * The home: the status line, the `Needs you` inbox while something waits, then the projects as cards (one column in a
 * narrow home, two in a wide one) with every agent, chat or terminal, in its project. Opening an agent does not review
 * it; `Reviewed` does, with one `Undo`. `onAddMachine` offers the first-run pointer when only this computer is known.
 */
export function Board(props: { onOpen: (row: BoardRow, options?: { reply?: boolean }) => void; onAddMachine?: () => void }) {
  const triage = signal(false);
  const width = signal(0);
  const columns = () => (width() >= TWO_COLUMNS_FROM ? 2 : 1);
  const lines = computed(() => homeLines(board().projects, columns(), moreOpen(), foldedProjects()));
  const inStrip = computed(() => new Set(strip(board()).rows.map((r) => r.key)));
  const order = computed(() => board().projects.flatMap((p) => (foldedProjects().includes(p.key) ? [] : shownRows(p.rows, moreOpen().includes(p.key)).shown.map((r) => r.key))));
  const machines = computed(() => {
    revision();
    return Herdr.machines().filter((m) => m.enabled);
  });
  const several = () => machines().length > 1;
  const lonely = () => machines().length <= 1 && board().projects.length === 0;

  return (
    <View class="min-h-0 flex-1 gap-2 px-4 pt-4" onLayout={({ bounds }) => width.set(bounds.size.width)}>
      <StatusLine />
      <If
        when={board().projects.length > 0}
        else={
          <Empty fill icon="monitor" title={lonely() ? "Add your first machine" : "No agents yet"} hint={lonely() ? "Agents running under herdr on this computer show up here. Add a machine to watch others too." : "Agents running under herdr appear here."}>
            <If when={lonely() && props.onAddMachine}>
              <Btn label="Add machine" onPress={() => props.onAddMachine?.()} />
            </If>
          </Empty>
        }
      >
        <Scroll class="min-h-0 flex-1" contentClass="gap-3 pb-6" accessibilityLabel="Projects">
          <NeedsYou onTriage={() => triage.set(true)} onOpen={props.onOpen} />
          <Each of={lines()} key={(l: HomeLine) => l.key}>
            {(line) => (
              <View class="flex-row items-start gap-3">
                <Each of={line().projects} key={(p: BoardProject) => p.key}>
                  {(project) => <ProjectCard project={project()} several={several()} order={order} inStrip={inStrip} onOpen={props.onOpen} />}
                </Each>
                <If when={columns() === 2 && !line().alone && line().projects.length === 1}>
                  <View class="flex-1" />
                </If>
              </View>
            )}
          </Each>
        </Scroll>
      </If>
      <Triage open={triage()} onClose={() => triage.set(false)} onOpen={props.onOpen} />
    </View>
  );
}
