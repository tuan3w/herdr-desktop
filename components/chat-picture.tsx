import { Image, signal, Text, View } from "nsh";

import type { PressEvent } from "nsh/types";

import { openLink } from "#components/open-link";
import { FOCUS_RING, Icon, notify, Tipped } from "#kit";
import {
  loadThumb,
  rememberSize,
  THUMB_PLACEHOLDER,
  THUMB_WIDTH,
  thumbBox,
  thumbKey,
  thumbSize,
  thumbState,
} from "#lib/chat-pictures";
import { sizeText } from "#lib/files";
import type { LinkPanel } from "#lib/link-panel";
import { viewFile } from "#lib/open-files";
import { apple } from "#lib/shortcuts";

/** Where a picture of a message is, and where a press on it goes. */
export interface PictureContext {
  machine: string;
  folder: string;
  /** The surface's side panel; without one a picture opens in the viewer, a web address in the browser. */
  links?: LinkPanel;
}

/** `mod` held at a press: the old way (the viewer's tab, the browser) instead of the side panel. */
export const modHeld = (e: { modifiers: PressEvent["modifiers"] }): boolean =>
  apple() ? e.modifiers.platform : e.modifiers.control;

const CHIP =
  "my-1 flex-row items-center gap-2 self-start rounded-md border border-border bg-muted px-2 py-1 hover:bg-accent";

/** A picture as a line: what it is called and why it is not drawn. */
function PictureChip(props: { text: string; tip?: string; onPress: (e: PressEvent) => void }) {
  const chip = () => (
    <View role="button" accessibilityLabel={props.text} onPress={props.onPress} class={`${CHIP} ${FOCUS_RING}`}>
      <Icon name="image" size={14} tone="muted-foreground" />
      <Text class="text-sm text-foreground">{props.text}</Text>
    </View>
  );
  return (
    <If when={props.tip} else={chip()}>
      {(tip) => (
        <Tipped label={tip()} side="top" class="self-start">
          {chip()}
        </Tipped>
      )}
    </If>
  );
}

/**
 * A picture an agent's Markdown names (`design/chat.md`, "Links and pictures"). A path on the session's machine is a
 * thumbnail at most `THUMB_WIDTH` wide with its name and pixel size under it, fetched once (`lib/chat-pictures.ts`); while
 * it comes, its box is held (its last size, else `THUMB_PLACEHOLDER`), with nothing spinning. A press opens it large in the
 * side panel (`mod`: the viewer). Over `THUMB_CAP` it is a chip that opens it in the panel. A web address is never
 * fetched: the chat does not phone out; it is a chip that opens the address in the panel. `mention` is a picture the agent
 * only named in words: nothing is drawn unless it is found.
 */
export function ChatPicture(props: { src: string; alt: string; at: PictureContext; mention?: boolean }) {
  const web = /^https?:\/\//i.test(props.src);
  const local = !/^[a-z][a-z0-9+.-]*:/i.test(props.src);
  const file = (props.src.split(/[?#]/)[0] ?? "").split("/").findLast(Boolean) ?? "";
  // A picture of the machine is named by its file, as the panel names it; a web one by what the agent called it. The
  // agent's words for it are what a screen reader hears.
  const name = () => (local ? file : props.alt) || file || props.alt || "image";
  const spoken = () => props.alt || name();
  const key = thumbKey(props.at.machine, props.at.folder, props.src);
  if (local) void loadThumb(props.at.machine, props.at.folder, props.src);
  const state = () => thumbState(key);
  // The size drawn wins; until then the one the header stated (or the last drawing), read again when the state moves.
  const drawn = signal<{ width: number; height: number } | undefined>(undefined);
  const natural = () => {
    void state();
    return drawn() ?? thumbSize(key);
  };
  const box = () => {
    const n = natural();
    return n ? thumbBox(n, THUMB_WIDTH) : THUMB_PLACEHOLDER;
  };
  const open = (path: string, e?: PressEvent, uri?: string) => {
    if (props.at.links && !(e && modHeld(e)))
      props.at.links.show({ kind: "picture", machine: props.at.machine, path, uri });
    else viewFile(props.at.machine, path);
  };
  const ready = () => {
    const s = state();
    return s.state === "ready" ? s : undefined;
  };
  /** A picture found but not drawn: too heavy, or its bytes would not read. Its chip still opens it in the panel. */
  const shut = () => {
    const s = state();
    if (s.state === "large")
      return { text: `Image: ${name()} · too large to show`, tip: sizeText(s.bytes), path: s.path };
    if (s.state === "failed") return { text: `Image: ${name()} · can't be shown`, tip: s.message, path: s.path };
    return undefined;
  };
  const missing = () => {
    const s = state();
    return s.state === "missing" ? s : undefined;
  };
  const caption = () => {
    const n = natural();
    return n ? `${name()} · ${n.width} × ${n.height}` : name();
  };

  return (
    <If
      when={local}
      else={
        <PictureChip
          text={`Image: ${name()}`}
          tip={web ? "Opens the address; nothing is loaded until then" : undefined}
          onPress={(e) =>
            web
              ? void openLink("url", props.src, null, null, {
                  machine: props.at.machine,
                  cwd: props.at.folder,
                  panel: props.at.links,
                  external: modHeld(e),
                })
              : notify(`${props.src} is not a picture of the agent's machine`)
          }
        />
      }
    >
      <If when={ready()}>
        {(r) => (
          <View class="my-1 gap-1 self-start">
            <View
              role="button"
              accessibilityLabel={`Picture ${caption()}`}
              onPress={(e) => open(r().path, e, r().uri)}
              style={{ width: box().width, height: box().height }}
              class={`overflow-hidden rounded-md border border-border bg-muted ${FOCUS_RING}`}
            >
              <Image
                src={r().uri}
                accessibilityLabel={spoken()}
                onLoad={({ size }) => {
                  const n = { width: Math.round(size.width), height: Math.round(size.height) };
                  rememberSize(key, n);
                  drawn.set(n);
                }}
                style={{ width: box().width, height: box().height, opacity: natural() ? 1 : 0 }}
              />
            </View>
            <Text class="text-xs text-muted-foreground">{caption()}</Text>
          </View>
        )}
      </If>
      <If when={state().state === "loading" && !(props.mention && natural() === undefined)}>
        <View
          accessibilityLabel={`Picture ${name()}, loading`}
          accessibilityState={{ busy: true }}
          class="my-1 gap-1 self-start"
        >
          <View style={{ width: box().width, height: box().height }} class="rounded-md border border-border bg-muted" />
          <Text class="text-xs text-muted-foreground">{caption()}</Text>
        </View>
      </If>
      <If when={shut()}>{(s) => <PictureChip text={s().text} tip={s().tip} onPress={(e) => open(s().path, e)} />}</If>
      <If when={!props.mention ? missing() : undefined}>
        {(m) => (
          <PictureChip text={`Image: ${name()} · not found`} tip={m().message} onPress={() => notify(m().message)} />
        )}
      </If>
    </If>
  );
}
