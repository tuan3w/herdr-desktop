import { mount, signal, Text, View } from "nsh";

import { Btn, IconButton } from "./kit/button";
import { PopupRoot } from "./kit/popup-root";
import { ThemeRoot } from "./kit/theme-root";

/** Test entry only (`buttons.test.tsx`): an icon button with a shortcut, a busy button and a disabled one, with their press counts. */
function Lab() {
  const reloads = signal(0);
  const saves = signal(0);
  const busy = signal(true);
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 gap-3 bg-background p-6">
        <View class="flex-row items-center gap-3">
          <IconButton
            icon="refresh"
            label="Reload changes"
            shortcut="Ctrl+R"
            onPress={() => reloads.update((n) => n + 1)}
          />
          <IconButton
            icon="plus"
            label="New agent session in offline"
            disabled
            onPress={() => reloads.update((n) => n + 100)}
          />
          <Btn label="Save" loading={busy()} onPress={() => saves.update((n) => n + 1)} />
          <Btn label="Locked" disabled onPress={() => undefined} />
          <Btn label="Finish" onPress={() => busy.set(false)} />
        </View>
        <Text>{`reloads:${reloads()}`}</Text>
        <Text>{`saves:${saves()}`}</Text>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
