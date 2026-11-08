import { host, mount, signal, Text, View } from "nsh";

import { NewSession } from "#components/new-session";
import { ThemeRoot, ToastHost } from "#kit";
import { startHerdr } from "#lib/herdr";

/**
 * The entry of `new-worktree.test.tsx` (and its screenshots): `New agent session` against a scripted herdr that serves
 * repositories from memory (`fixtures/herdr/<fixture>.json`, key `worktrees`). `fixture` and `project` are launch
 * parameters. Not part of the app.
 */
const params = host.params as {
  fixture?: string;
  project?: { machine: string; folder: string; worktree?: boolean };
};
startHerdr("", params.fixture ?? "worktrees");

function Lab() {
  const open = signal(true);
  const opened = signal("nothing opened");
  return (
    <ThemeRoot>
      <View class="flex-1 gap-3 bg-background p-4">
        <Text class="text-xs text-muted-foreground">{opened()}</Text>
        <NewSession
          open={open()}
          project={params.project}
          onClose={() => open.set(false)}
          onStarted={(m, id) => opened.set(`Opened ${m}/${id}`)}
        />
      </View>
      <ToastHost />
    </ThemeRoot>
  );
}

mount(Lab);
