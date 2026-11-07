import { host, mount, signal, Text, View } from "nsh";

import { AnswerDock } from "#components/answer-dock";
import { ThemeRoot, ToastHost } from "#kit";
import { fromPrompt } from "#lib/ask";
import { board, meta, startHerdr } from "#lib/herdr";

/**
 * The entry of `answer-dock.test.tsx`: the dock of one pane of the scripted herdr (`fixture` and `pane` come from the
 * launch parameters) and lines that count what the dock reported as sent and how often `Next` was pressed. Not part of the app.
 */
const params = host.params as { fixture?: string; pane?: string };
startHerdr("", params.fixture ?? "mixed");
const MACHINE = "local";
const PANE = params.pane ?? "w1:p1";

function Lab() {
  const header = meta(MACHINE, PANE);
  const sent = signal(0);
  const next = signal(0);
  // The other agents that wait: what `Next` counts.
  const others = () => board().needsYou.filter((r) => !r.offline && r.paneId !== PANE).length;
  return (
    <ThemeRoot>
      <View class="flex-1 gap-2 bg-background p-4">
        <Text class="text-sm text-foreground">{`Status: ${header()?.status ?? "unknown"}`}</Text>
        <Text class="text-sm text-foreground">{`Reported sent: ${sent()}`}</Text>
        <Text class="text-sm text-foreground">{`Next pressed: ${next()}`}</Text>
        <If when={header()?.prompt} else={<Text class="text-sm text-muted-foreground">No question</Text>}>
          {(prompt) => (
            <AnswerDock
              ask={fromPrompt(prompt(), { machine: MACHINE, pane: PANE }, others())}
              onSent={() => sent.update((n) => n + 1)}
              onNext={() => next.update((n) => n + 1)}
            />
          )}
        </If>
      </View>
      <ToastHost />
    </ThemeRoot>
  );
}

mount(Lab);
