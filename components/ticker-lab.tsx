import { mount, signal, Text, View } from "nsh";

import { Btn, Progress, Spinner, tickerRunning, ThemeRoot } from "#kit";

/** The entry of `ticker.test.tsx`: indicators that mount and unmount on a button, and whether the shared timer exists. Not part of the app. */
function Lab() {
  const count = signal(0);
  const clock = signal(0);
  // The timer lives outside the render, so the lab polls it on the (test) clock.
  setInterval(() => clock.set(tickerRunning() ? 1 : 0), 10);
  return (
    <ThemeRoot>
      <View class="gap-2 p-4">
        <Btn label="More" onPress={() => count.update((n) => n + 1)} />
        <Btn label="Clear" onPress={() => count.set(0)} />
        <Text>{`timer ${clock() ? "on" : "off"}`}</Text>
        <Each of={Array.from({ length: count() }, (_, i) => i)} key="index">
          {() => <Spinner />}
        </Each>
        <If when={count() > 3}>
          <Progress value={null} label="Indexing" />
        </If>
      </View>
    </ThemeRoot>
  );
}

mount(Lab);
