import { host, keymap, mount, signal, Text, View } from "nsh";

import { Composer } from "#components/composer";
import { PaneTab } from "#components/pane-tab";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { startHerdr } from "#lib/herdr";
import { captureActive, paneInFront, searchInPane, showLinks, toggleCapture } from "#lib/pane-input";
import { loadSettings, paneFit, quickPhrases } from "#lib/settings";
import { GLOBAL, keysOf } from "#lib/shortcuts";

/**
 * The entry of `pane-tab.test.tsx`: one pane tab of the scripted herdr (`fixture` and `pane` come from the launch
 * parameters), bound to the global keys the way `App.tsx` binds them, and a line for what the app reports. With
 * `broken: true` it shows only a message box whose machine does not exist, so every send fails. Not part of the app.
 */
const params = host.params as { fixture?: string; pane?: string; broken?: boolean };
startHerdr("", params.fixture ?? "mixed");
void loadSettings();
const MACHINE = "local";

function Lab() {
  const active = signal(true);
  const opened = signal("nothing opened");
  keymap.bind(keysOf(GLOBAL.capture)[0], () => toggleCapture());
  keymap.bind(keysOf(GLOBAL.search)[0], () => searchInPane());
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-row flex-wrap items-center gap-2 border-b border-border p-2">
          <Text class="text-xs text-foreground">{`Capture: ${captureActive() ? "on" : "off"}`}</Text>
          <Text class="text-xs text-foreground">{`Fit: ${paneFit()}`}</Text>
          <Text class="text-xs text-foreground">{`Pane in front: ${paneInFront() ? "yes" : "no"}`}</Text>
          <Text class="text-xs text-foreground">{opened()}</Text>
          <Btn small label="Show links" onPress={() => showLinks()} />
          <Btn small label="Make pane inactive" onPress={() => active.set(false)} />
          <Btn small label="Make pane active" onPress={() => active.set(true)} />
          <Btn small label="Turn quick phrases off" onPress={() => quickPhrases.set(false)} />
        </View>
        <If
          when={params.broken}
          else={
            <PaneTab
              machine={MACHINE}
              pane={params.pane ?? "w1:p4"}
              active={active()}
              onOpenPane={(machine, pane) => opened.set(`Opened ${machine}/${pane}`)}
            />
          }
        >
          <Composer
            machine="nowhere"
            pane="w9:p9"
            agent="omp"
            name="Lost agent"
            blocked={false}
            disabled={false}
            onHandle={() => undefined}
            onSent={() => undefined}
          />
        </If>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
