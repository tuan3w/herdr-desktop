import { mount, Text, token, View } from "nsh";
import { Button } from "nsh/base";

import { ThemeRoot } from "#kit";
import { themeId } from "#lib/settings";
import { THEMES } from "#lib/theme/themes";

/** Test entry only: shows the live `primary` token and one button per theme, to prove `ThemeRoot` really restyles. */
function Probe() {
  return (
    <ThemeRoot>
      <View class="flex-1 gap-2 bg-background p-4">
        <Text testID="primary" class="text-foreground">
          {token("primary")}
        </Text>
        <View testID="swatch" class="h-8 w-20 bg-primary" />
        <Each of={THEMES}>
          {(spec) => (
            <Button onPress={() => themeId.set(spec().id)} class="h-8 border border-input px-2">
              <Text class="text-foreground">{spec().id}</Text>
            </Button>
          )}
        </Each>
      </View>
    </ThemeRoot>
  );
}

mount(Probe);
