import { mount, signal, Text, View } from "nsh";

import { Btn, Modal, PopupRoot, ThemeRoot } from "#kit";

/**
 * The entry of `modal.test.tsx`: a `Modal` opened the way Settings is, while a page signal is set (`open={page() !==
 * null}`), with a nav that changes the page while it stays open. Its body counts how many times it was built, which is
 * what a person sees as the content going away and coming back. Not part of the app.
 */
const page = signal<"first" | "second" | null>(null);
let built = 0;

function Body() {
  built += 1;
  return (
    <View class="gap-2 p-4">
      <Btn label="First page" onPress={() => page.set("first")} />
      <Btn label="Second page" onPress={() => page.set("second")} />
      <Text>{`showing ${page()}`}</Text>
      <Text>{`built ${built}`}</Text>
    </View>
  );
}

function Probe() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1">
        <Btn label="Open" onPress={() => page.set("first")} />
        <Modal open={page() !== null} size="settings" title="Pages" onClose={() => page.set(null)}>
          <Body />
        </Modal>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Probe);
