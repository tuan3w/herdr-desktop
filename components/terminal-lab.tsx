import { Terminal } from "herdr-desktop/native";
import { host, mount, View } from "nsh";

import { ThemeRoot } from "#kit";
import { terminalFontSize, terminalOptionAsMeta } from "#lib/settings";

/**
 * Test entry (not the app): the real `Terminal` view running a synthetic program, to look at it in a render and to drive it in
 * `make shots-mac`. Launch parameters: `command` (what to run; synthetic programs only, never a herdr), `size` (points; the
 * saved setting by default). The program is never a real pane: a terminal starts only with an explicit command.
 */
const params = host.params as { command?: string; size?: number; font?: string };
// A lab under components/ does not find fonts/ (an app finds its fonts only under its entry directory) and nsh then falls back to a
// proportional face, which breaks every column: name a system monospace instead. The real app uses the theme's IBM Plex Mono.
const font = String(params.font ?? "Menlo");
const command = String(params.command ?? "printf 'no command given\\r\\n'; sleep 30");

function Lab() {
  return (
    <ThemeRoot>
      <View class="flex-1 bg-background">
        <Terminal
          label="lab"
          command={command}
          fontFamily={font}
          fontSize={params.size ?? terminalFontSize()}
          optionAsMeta={terminalOptionAsMeta()}
        />
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
