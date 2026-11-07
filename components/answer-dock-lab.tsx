import { host, mount, signal, Text, View } from "nsh";

import { AnswerDock } from "#components/answer-dock";
import { ThemeRoot, ToastHost } from "#kit";
import { meta, startHerdr } from "#lib/herdr";

/**
 * The entry of `answer-dock.test.tsx`: the dock of one pane of the scripted herdr (`fixture` and `pane` come from the
 * launch parameters) and a line that counts what the dock reported as sent. Not part of the app.
 */
const params = host.params as { fixture?: string; pane?: string };
startHerdr("", params.fixture ?? "mixed");
const MACHINE = "local";
const PANE = params.pane ?? "w1:p1";

function Lab() {
  const header = meta(MACHINE, PANE);
  const sent = signal(0);
  return (
    <ThemeRoot>
      <View class="flex-1 gap-2 bg-background p-4">
        <Text class="text-sm text-foreground">{`Status: ${header()?.status ?? "unknown"}`}</Text>
        <Text class="text-sm text-foreground">{`Reported sent: ${sent()}`}</Text>
        <If when={header()?.prompt} else={<Text class="text-sm text-muted-foreground">No question</Text>}>
          {(prompt) => (
            <AnswerDock machine={MACHINE} pane={PANE} prompt={prompt()} onSent={() => sent.update((n) => n + 1)} />
          )}
        </If>
      </View>
      <ToastHost />
    </ThemeRoot>
  );
}

mount(Lab);
