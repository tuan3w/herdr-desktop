import { Files, Media } from "herdr-desktop/native";
import { Clipboard, signal, View } from "nsh";

import { Btn, copyText, notify } from "#kit";
import { revealLabel } from "#lib/files";
import { mentionInChat } from "#lib/pane-input";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface FileTarget {
  machine: string;
  path: string;
  name: string;
}

/**
 * What can be done with a file, as functions with their state: `send` mentions it in the open chat's message, `open` hands
 * it to the system's application (another machine's file is copied to this computer first), `reveal` shows it in Finder or
 * the file manager, `copyImage` puts a picture on the clipboard. Each failure says why in a toast. The row of buttons
 * below and the lightbox's menu both use them.
 */
export function fileActions(props: FileTarget) {
  const opening = signal(false);
  const copying = signal(false);
  const failed = (what: string) => (e: unknown) => notify(`${what}: ${reason(e)}`, { type: "error" });
  return {
    opening,
    copying,
    send() {
      if (mentionInChat(props.machine, props.path)) notify(`${props.name} added to the message`);
      else notify("Open the agent's chat on this machine first, then send the file", { type: "error" });
    },
    open() {
      opening.set(true);
      void Files.openExternally(props.machine, props.path)
        .catch(failed("Could not open the file"))
        .finally(() => opening.set(false));
    },
    reveal() {
      void Files.reveal(props.machine, props.path).catch(failed("Could not show the file"));
    },
    copyImage() {
      copying.set(true);
      void Media.imageDataUrl(props.machine, props.path)
        .then((url) => Clipboard.writeImage(url))
        .then(() => notify("Image copied"))
        .catch(failed("Could not copy the image"))
        .finally(() => copying.set(false));
    },
  };
}

/**
 * What can be done with a file from a viewer, in one row: `Send to the agent` (mentions it in the open chat's message,
 * as `@` would), `Open` with the system's application (another machine's file is copied to this computer first, up to
 * the media cache's cap), `Reveal` in Finder or the file manager (this computer only), `Copy path`, and `Copy contents` for
 * what is text. Each failure says why in a toast.
 */
export function FileActions(props: {
  machine: string;
  path: string;
  name: string;
  /** The file is on this computer: it can be revealed. */
  local: boolean;
  /** The text the viewer shows (copied as shown); undefined when the file has none to copy. */
  text?: string;
}) {
  const act = fileActions(props);

  return (
    <View class="flex-row flex-wrap items-center gap-2" role="group" accessibilityLabel="File actions">
      <Btn small icon="send" label="Send to the agent" onPress={act.send} />
      <Btn
        small
        icon="external-link"
        label="Open"
        name="Open with the system's application"
        loading={act.opening()}
        onPress={act.open}
      />
      <If when={props.local}>
        <Btn small icon="folder" label="Reveal" name={revealLabel()} onPress={act.reveal} />
      </If>
      <Btn small icon="copy" label="Copy path" onPress={() => void copyText(props.path, "Path")} />
      <If when={props.text !== undefined}>
        <Btn small icon="copy" label="Copy contents" onPress={() => void copyText(props.text ?? "", "Contents")} />
      </If>
    </View>
  );
}
