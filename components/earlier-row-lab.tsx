import { mount, signal, Text, View } from "nsh";

import { EarlierRow } from "#components/earlier-row";
import { Btn, ThemeRoot } from "#kit";
import type { Earlier } from "#lib/earlier";

/** The entry of `earlier-row.test.tsx`: the row in each state, and how many times it asked. Not part of the app. */
function Lab() {
  const state = signal<Earlier>("available");
  const asked = signal(0);
  return (
    <ThemeRoot>
      <View class="w-[600px] gap-2 p-4">
        <EarlierRow earlier={state()} onLoad={() => asked.update((n) => n + 1)} />
        <Text>{`asked ${asked()}`}</Text>
        <Btn label="Available" onPress={() => state.set("available")} />
        <Btn label="Loading" onPress={() => state.set("loading")} />
        <Btn label="Too long" onPress={() => state.set("tooLong")} />
        <Btn label="None" onPress={() => state.set("none")} />
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
