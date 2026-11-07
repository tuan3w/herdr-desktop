import { mount, signal, Text, View } from "nsh";
import { Palette, type PaletteItem } from "./Palette";
import { Btn, ThemeRoot } from "./kit";

const ITEMS: PaletteItem[] = [
  { id: "board", label: "Go to board", group: "Go", shortcut: "mod+1" },
  { id: "next", label: "Next agent that needs you", group: "Go", shortcut: "mod+j", keywords: ["attention"] },
  { id: "settings", label: "Settings", group: "App", shortcut: "mod+," },
  { id: "locked", label: "Close pane", group: "App", disabled: true },
];

/** The entry of `palette.test.tsx`: a button that opens the palette and a line that says what ran. Not part of the app. */
function Lab() {
  const open = signal(false);
  const ran = signal("nothing ran");
  return (
    <ThemeRoot>
      <View class="flex-1 gap-2 bg-background p-4">
        <Btn label="Open palette" onPress={() => open.set(true)} />
        <Text>{ran()}</Text>
        <Palette open={open()} onClose={() => open.set(false)} items={ITEMS} onRun={(id) => ran.set(`ran ${id}`)} />
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
