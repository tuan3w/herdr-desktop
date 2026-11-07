import { Herdr } from "herdr-desktop/native";
import { computed, effect, Scroll, signal, Text, View } from "nsh";

import type { BoardProject, BoardRow } from "herdr-desktop/native";

import { Opener, ProjectCard, Question } from "#components/board-card";
import { Triage } from "#components/triage";
import { Btn, Empty, FOCUS_RING, NUM, Swap } from "#kit";
import { type HomeLine, homeLines, strip } from "#lib/board-items";
import { allRows, board, projectOf, revision, reviewable } from "#lib/herdr";
import { COLUMN, GAP, PAD, TWO_COLUMNS_FROM } from "#lib/layout";
import { animateLayout, hoverTransition } from "#lib/motion";
import { select } from "#lib/selection";
import { foldedProjects, moreOpen, shownRows } from "#lib/sidebar";

/**
 * The status line, one count for every surface, all in the muted ink (the `Needs you` inbox just under it is the loud
 * thing: a number in colour here would say the same twice). `3 to review` is a button that picks exactly those agents (and
 * opens the projects that were folded over them) for the bulk bar's `Reviewed`.
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
    <View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
      <Each of={parts()} key="index">
        {(part, i) => (
          <View class="flex-row items-center gap-2">
            <If when={i() > 0}>
              <Text class="text-sm text-muted-foreground">·</Text>
            </If>
            <If
              when={/^\d+ to review/.test(part())}
              else={<Swap class="text-sm text-muted-foreground" text={part()} />}
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
 * `AnswerDock`. It owns the loud treatment of an agent that waits (the signal disc): everywhere else the same agent is a
 * quiet shape and words. One agent is answered in place so the projects stay in view; the rest are counted by project
 * (`docs 4 · infra 4`, never a wall of rows) and are one `Answer one by one` away. It exists only while something waits,
 * takes no room otherwise.
 */
function NeedsYou(props: { onTriage: () => void; onOpen: (row: BoardRow, options?: { reply?: boolean }) => void }) {
  const waiting = computed(() => strip(board()));
  // The inbox arriving or going pushes the cards: they glide instead of jumping.
  let had: boolean | undefined;
  effect(() => {
    const has = waiting().rows.length > 0;
    if (had !== undefined && has !== had) animateLayout();
    had = has;
  });
  return (
    <If when={waiting().rows.length > 0}>
      <View role="group" accessibilityLabel="Needs you" class="gap-2 rounded-xl border border-border bg-card p-4">
        <View class="min-h-9 flex-row items-center justify-between px-1">
          <View class="flex-row items-baseline gap-2">
            <Text role="header" class="text-base font-semibold text-foreground">
              Needs you
            </Text>
            <Swap class="text-sm text-muted-foreground" text={`${board().counts.needsYou}`} />
          </View>
          <If when={board().counts.needsYou > 1}>
            <Btn small label="Answer one by one" onPress={props.onTriage} />
          </If>
        </View>
        <Each of={waiting().rows} key={(r: BoardRow) => r.key}>
          {(row) => (
            <If when={projectOf(row().project)}>
              {(project) => (
                <View class="gap-1">
                  <View class="flex-row items-center">
                    <Opener row={row()} project={project()} loud onOpen={props.onOpen} />
                  </View>
                  <View class="pl-10 pr-3">
                    <Question row={row()} onOpen={props.onOpen} />
                  </View>
                </View>
              )}
            </If>
          )}
        </Each>
        <If when={waiting().more > 0}>
          <Text class="px-3 text-sm text-muted-foreground">
            {`${waiting().more} more waiting · ${waiting()
              .moreIn.map((g) => `${g.name} ${g.count}`)
              .join(" · ")}`}
          </Text>
        </If>
      </View>
    </If>
  );
}

/**
 * The home: the status line, the `Needs you` inbox while something waits, then the projects as cards (one column in a
 * narrow home, two in a wide one, a calm column that stops growing on a very wide window) with every agent, chat or
 * terminal, in its project. Opening an agent does not review it; `Reviewed` does, with one `Undo`. `onAddMachine` offers
 * the first-run pointer when only this computer is known.
 */
export function Board(props: {
  onOpen: (row: BoardRow, options?: { reply?: boolean }) => void;
  onAddMachine?: () => void;
}) {
  /** Open on the walk of `Answer one by one`, starting at an agent when its own `Answer` was pressed. */
  const triage = signal<{ at?: string } | null>(null);
  const width = signal(0);
  const columns = () => (width() >= TWO_COLUMNS_FROM ? 2 : 1);
  const lines = computed(() => homeLines(board().projects, columns(), moreOpen(), foldedProjects()));
  const order = computed(() =>
    board().projects.flatMap((p) =>
      foldedProjects().includes(p.key) ? [] : shownRows(p.rows, moreOpen().includes(p.key)).shown.map((r) => r.key),
    ),
  );
  const machines = computed(() => {
    revision();
    return Herdr.machines().filter((m) => m.enabled);
  });
  const several = () => machines().length > 1;
  const lonely = () => machines().length <= 1 && board().projects.length === 0;
  // A chat is answered in its own tab, where its permission dock is; a terminal agent in the walk, at that agent.
  const answer = (row: BoardRow) => (row.session ? props.onOpen(row) : triage.set({ at: row.key }));

  return (
    <View class="min-h-0 flex-1" onLayout={({ bounds }) => width.set(Math.min(bounds.size.width, COLUMN.home))}>
      <If
        when={board().projects.length > 0}
        else={
          <>
            <View class={`${PAD.page} pb-2`}>
              <StatusLine />
            </View>
            <Empty
              fill
              icon="monitor"
              title={lonely() ? "Add your first machine" : "No agents yet"}
              hint={
                lonely()
                  ? "Agents running under herdr on this computer show up here. Add a machine to watch others too."
                  : "Agents running under herdr appear here."
              }
            >
              <If when={lonely() && props.onAddMachine}>
                <Btn label="Add machine" onPress={() => props.onAddMachine?.()} />
              </If>
            </Empty>
          </>
        }
      >
        <Scroll class="min-h-0 flex-1" contentClass="items-center" accessibilityLabel="Projects">
          <View class={`w-full pb-8 ${PAD.page} ${GAP.section}`} style={{ maxWidth: COLUMN.home }}>
            <StatusLine />
            <NeedsYou onTriage={() => triage.set({})} onOpen={props.onOpen} />
            <Each of={lines()} key={(l: HomeLine) => l.key}>
              {(line) => (
                <View class={`flex-row items-start ${GAP.section}`}>
                  <Each of={line().projects} key={(p: BoardProject) => p.key}>
                    {(project) => (
                      <ProjectCard
                        project={project()}
                        several={several()}
                        order={order}
                        onAnswer={answer}
                        onOpen={props.onOpen}
                      />
                    )}
                  </Each>
                  <If when={columns() === 2 && !line().alone && line().projects.length === 1}>
                    <View class="flex-1" />
                  </If>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </If>
      <Triage open={triage() !== null} start={triage()?.at} onClose={() => triage.set(null)} onOpen={props.onOpen} />
    </View>
  );
}
