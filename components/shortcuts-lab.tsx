import { mount, signal, View } from "nsh";

import { Shortcuts } from "#components/shortcuts";
import { Btn, ThemeRoot } from "#kit";

/** The entry of `shortcuts.test.tsx`: one button that opens the shortcuts list, as the app's `shortcuts` key will. Not part of the app. */
function Lab() {
  const open = signal(false);
  return (
    <ThemeRoot>
      <View class="flex-1 bg-background p-4">
        <Btn label="Show shortcuts" onPress={() => open.set(true)} />
        <Shortcuts open={open()} onClose={() => open.set(false)} />
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
