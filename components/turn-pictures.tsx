import { effect, Image, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { ImageView } from "herdr-desktop/native";

import { Lightbox, pictureMenu } from "#components/lightbox-view";
import { FOCUS_RING, Icon } from "#kit";
import { loadPicture, pictureSize, pictureState } from "#lib/session-pictures";

/** A thumbnail is this many points square. */
const THUMB = 72;

/**
 * The pictures of one message of a chat read from a log, as a row of thumbnails under its words. A row asks for its
 * pictures once, when it is drawn; a press on one opens it in the lightbox. One that is too large, gone or let go of
 * says so in a tile of the same height, so the row never changes height when the bytes arrive.
 */
export function TurnPictures(props: { images: readonly ImageView[]; machine: string; id: string }) {
  return (
    <View class="flex-row flex-wrap gap-2 pt-2">
      <Each of={props.images} key={(i: ImageView) => i.key}>
        {(image, index) => (
          <Thumb
            image={image()}
            position={index() + 1}
            count={props.images.length}
            machine={props.machine}
            id={props.id}
          />
        )}
      </Each>
    </View>
  );
}

function Thumb(props: { image: ImageView; position: number; count: number; machine: string; id: string }) {
  const open = signal(false);
  const state = () => pictureState(props.image.key);
  const name = () => (props.count > 1 ? `Picture ${props.position} of ${props.count}` : "Picture");
  const fetch = () => void loadPicture(props.machine, props.id, props.image);
  // Once per cell: what is read here is not tracked, so a picture the cache let go of is not fetched again by itself.
  effect(() => {
    untracked(() => {
      if (state().state === "idle") fetch();
    });
  });
  const ready = (): string | null => {
    const s = state();
    return s.state === "ready" ? s.uri : null;
  };
  const failure = (): string | null => {
    const s = state();
    return s.state === "failed" ? s.message : null;
  };
  const tile = "h-[72px] items-center justify-center gap-1 rounded-lg border border-border bg-muted px-2";
  return (
    <View>
      <If when={ready()}>
        {(uri) => (
          <>
            <Button
              onPress={() => open.set(true)}
              accessibilityLabel={`Open ${name().toLowerCase()}`}
              class={`rounded-lg ${FOCUS_RING}`}
            >
              <Image
                src={uri()}
                accessibilityLabel={name()}
                style={{ width: THUMB, height: THUMB, objectFit: "cover" }}
                class="rounded-lg border border-border"
              />
            </Button>
            <If when={open()}>
              <Lightbox url={uri()} name={name()} entries={pictureMenu(uri())} onClose={() => open.set(false)} />
            </If>
          </>
        )}
      </If>
      <If when={state().state === "large"}>
        <View role="group" accessibilityLabel={`${name()} is too large to show`} class={`${tile} w-[132px]`}>
          <Icon name="image" size={14} tone="muted-foreground" />
          <Text class="text-center text-xs text-muted-foreground">Picture too large to show</Text>
        </View>
      </If>
      <If when={state().state === "loading"}>
        <View
          role="group"
          accessibilityLabel={`Loading ${name().toLowerCase()}`}
          accessibilityState={{ busy: true }}
          class={`${tile} w-[72px]`}
        >
          <Icon name="image" size={14} tone="muted-foreground" />
        </View>
      </If>
      <If when={state().state === "idle" || state().state === "failed"}>
        <Button
          onPress={fetch}
          accessibilityLabel={`Load ${name().toLowerCase()}${props.image.bytes ? `, ${pictureSize(props.image.bytes)}` : ""}${failure() ? `. ${failure()}` : ""}`}
          class={`${tile} w-[96px] hover:bg-accent ${FOCUS_RING}`}
        >
          <Icon name="image" size={14} tone="muted-foreground" />
          <Text class="text-center text-xs text-muted-foreground">
            {state().state === "failed" ? "Try again" : "Load"}
          </Text>
        </Button>
      </If>
    </View>
  );
}
