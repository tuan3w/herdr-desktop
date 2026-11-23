import { Scroll, View, Text } from "nsh";

import { StatusGlyph } from "#components/status-glyph";
import { Btn, Empty } from "#kit";
import { newSession } from "#lib/actions";
import { context } from "#lib/dock";
import { board, projectOf } from "#lib/herdr";
import { COLUMN, PAD } from "#lib/layout";
import { openAgent } from "#lib/open-agent";
import { ageText, projectFolder, rowLabel } from "#lib/sidebar";
import { stateWord } from "#lib/status";

/**
 * What a context's workspace shows while it has no tab open (a project never opened, or one whose last tab was closed,
 * the home the same): at the home, the empty state (`New session`); in a project, the project's own card: its agents
 * (name, state glyph, how long they have been in the state) in the sidebar's order and a `New session` in its folder, so
 * a context is never blank and the way into it is one press. A press on an agent opens it in this project's tabs.
 * Nothing here needs the person: what waits is said by the row's mark, as everywhere (`design/attention.md`).
 */
export function ProjectEmpty() {
  const project = () => projectOf(context());
  const rows = () => (project() ? (board().projects.find((p) => p.key === project()!.key)?.rows ?? []) : []);
  return (
    <Scroll
      class="min-h-0 flex-1"
      contentClass="items-center"
      accessibilityLabel={project() ? `${project()!.name}, no tabs open` : "Nothing open"}
    >
      <View class={`w-full pb-8 ${PAD.page}`} style={{ maxWidth: COLUMN.home }}>
        <If
          when={project()}
          else={
            <Empty fill title="Nothing open" hint="Open an agent from the sidebar, or start a new session.">
              <Btn label="New session" name="New agent session" onPress={() => newSession()} />
            </Empty>
          }
        >
          {(p) => (
            <View class="mt-8">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-base font-medium">{p().name}</Text>
                <Btn
                  small
                  variant="ghost"
                  label="New session"
                  name={`New agent session in ${p().name}`}
                  disabled={p().offline}
                  onPress={() => newSession({ machine: p().machine, folder: projectFolder(p()) })}
                />
              </View>
              <View class="mt-3 flex-col gap-1">
                <Each of={rows()} key={(r) => r.key}>
                  {(row) => (
                    <View
                      role="button"
                      onPress={() => void openAgent(row())}
                      accessibilityLabel={rowLabel(row(), p().name)}
                      class="flex-row min-h-7 items-center gap-3 rounded-md px-1"
                    >
                      <StatusGlyph status={row().offline ? "unknown" : row().status} id={row().key} />
                      <Text style={{ numberOfLines: 1 }} class="min-w-0 flex-1 text-sm text-foreground">
                        {row().name}
                      </Text>
                      <Text style={{ numberOfLines: 1 }} class="shrink-0 text-xs text-muted-foreground">
                        {stateWord(row().status, row().reviewed)}
                      </Text>
                      <Text class="w-12 shrink-0 text-right text-xs text-muted-foreground">
                        {ageText(row().sinceSecs)}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          )}
        </If>
      </View>
    </Scroll>
  );
}
