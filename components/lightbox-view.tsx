import { announce, cleanup, Clipboard, effect, Image, keymap, Scroll, signal, Text, View } from "nsh";
import { Button, Dialog } from "nsh/base";

import type { ScrollRef } from "nsh";

import { fileActions } from "#components/file-actions";
import {
  ActionMenu,
  Clipped,
  copyText,
  EDGE,
  Empty,
  FOCUS_RING,
  Icon,
  IconButton,
  type MenuEntry,
  newDialogId,
  notify,
  NUM,
  PopupRoot,
  Tipped,
  ToastHost,
  topDialog,
  trackDialog,
} from "#kit";
import { clampPan, overflows, rotatedBy, turned, zoomed, zoomPercent } from "#lib/image-view";
import type { Pan, Size, Turn } from "#lib/image-view";
import { CHROME_MS, createIdle, lightboxFit, nameLine, READOUT_MS, stepTarget, wheelZoom, zoomAt } from "#lib/lightbox";
import { DURATION, motionClock, presenceMotion, reducedMotion } from "#lib/motion";

/** The pixels one arrow key pans a zoomed picture. */
const PAN_STEP = 60;
/** How tall the scroll view is around the wheel sensor's middle (points); see `docs/specs/terminal.md`, "Wheel". */
const SENSOR_SPAN = 4000;
/** Width of the strip at each edge that shows its arrow while the pointer is in it. */
const EDGE_ZONE = "w-24";

/** A fade that is finite: it runs once to `shown` and stops. Under reduced motion `rests` says whether it may hide at all. */
function fader(shown: () => boolean, rests: () => boolean) {
  const motion = presenceMotion({ enter: DURATION.context, exit: DURATION.rise });
  let first = true;
  effect(() => {
    const now = shown() || !rests();
    if (first) {
      first = false;
      if (now) motion.show(true);
      return;
    }
    if (now) motion.show();
    else motion.hide();
  });
  return motion.style;
}

/**
 * A picture over a dimmed window, and almost nothing else: the name line at the top left, `...` and `Close` at the top
 * right, and that is all at rest. The controls fade after 2 s without the pointer moving (they stay under reduced motion
 * and while the menu is open); the previous and next arrows appear only under the pointer at an edge and are always
 * `Left` and `Right`; a zoom readout shows for 1.2 s after a zoom. The picture fits the window less an 8% margin; `+`,
 * `-` and the wheel zoom, `0` fits, `1` is its own size, double click toggles the two, a drag pans, `R` turns it.
 * `entries` is the `...` menu (what can be done with this file); `names` the folder's pictures, for `3 of 5` and the
 * arrows. A picture that cannot be shown says why on the scrim, with the menu still there. Escape closes.
 */
export function Lightbox(props: {
  /** The picture's address (a `data:` URI); without it `empty` is shown. */
  url?: string;
  name: string;
  /** The folder's pictures in order; the count and the arrows only when there is more than one. */
  names?: readonly string[];
  /** Goes to the picture called `name`. */
  go?: (name: string) => void;
  entries: MenuEntry[];
  empty?: { title: string; hint?: string };
  onClose: () => void;
}) {
  const id = newDialogId();
  trackDialog(id, () => true);
  const ask = () => {
    if (topDialog() === id) props.onClose();
  };

  const natural = signal<Size>({ width: 0, height: 0 });
  const box = signal<Size>({ width: 0, height: 0 });
  const failure = signal<string | null>(null);
  const turn = signal<Turn>(0);
  // `null` is a fit; a number is the scale the person chose.
  const chosen = signal<number | null>(null);
  const pan = signal<Pan>({ x: 0, y: 0 });
  let last: { x: number; y: number } | null = null;

  const fit = () => lightboxFit(natural(), turn(), box());
  const scale = () => chosen() ?? fit();
  const shown = (): Size => {
    const t = turned(natural(), turn());
    return { width: t.width * scale(), height: t.height * scale() };
  };
  const draggable = () => overflows(shown(), box());
  const place = (next: Pan) => pan.set(clampPan(next, shown(), box()));

  // The chrome and the readout rest by timers that a test can replace (`motionClock`).
  const chrome = signal(true);
  const readout = signal(false);
  const chromeIdle = createIdle(CHROME_MS, motionClock, (on) => chrome.set(on));
  // The level is said once, when a zoom has settled, not on every wheel event.
  const readoutIdle = createIdle(READOUT_MS, motionClock, (on) => {
    readout.set(on);
    if (!on && chosen() !== null) announce(`Zoom ${zoomPercent(scale())}`);
  });
  chromeIdle.poke();
  cleanup(() => {
    chromeIdle.stop();
    readoutIdle.stop();
  });
  const chromeStyle = fader(chrome, () => !reducedMotion());
  const readoutStyle = fader(
    () => readout() && chosen() !== null,
    () => true,
  );
  const left = signal(false);
  const right = signal(false);
  const leftStyle = fader(left, () => true);
  const rightStyle = fader(right, () => true);

  const setScale = (value: number | null) => {
    chosen.set(value);
    place(pan());
    if (value !== null) readoutIdle.poke();
    announce(`Zoom ${zoomPercent(value ?? fit())}`);
  };
  const step = (direction: 1 | -1) => setScale(zoomed(scale(), direction));
  // Where the pointer is, from the box's centre (the box is the whole window): a wheel zoom keeps that point still.
  let pointer: Pan | null = null;
  const zoomTo = (value: number) => {
    const from = scale();
    if (value === from) return;
    chosen.set(value);
    place(pointer ? zoomAt(pan(), pointer, from, value) : pan());
    readoutIdle.poke();
  };
  const rotate = () => {
    turn.update(rotatedBy);
    place(pan());
    announce(`Turned ${turn()} degrees`);
  };
  const move = (dx: number, dy: number) => {
    if (!draggable()) return false;
    place({ x: pan().x + dx, y: pan().y + dy });
    return true;
  };
  const toggle = () => setScale(chosen() === null ? 1 : null);

  const target = (direction: -1 | 1) => (props.names ? stepTarget(props.names, props.name, direction) : undefined);
  const walk = (direction: -1 | 1) => {
    const next = target(direction);
    if (next !== undefined) props.go?.(next);
  };

  // Another picture of the folder: back to a fit, upright.
  effect(() => {
    void props.name;
    chosen.set(null);
    turn.set(0);
    pan.set({ x: 0, y: 0 });
    failure.set(null);
    natural.set({ width: 0, height: 0 });
  });

  effect(() => {
    const keys = keymap.bind(
      { plus: () => step(1), minus: () => step(-1), "0": () => setScale(null), "1": () => setScale(1), r: rotate },
      { when: "notEditing" },
    );
    // At a fit the arrows walk the folder; zoomed in they move the picture.
    const arrows = keymap.bind(
      {
        left: () => (move(PAN_STEP, 0) ? undefined : walk(-1)),
        right: () => (move(-PAN_STEP, 0) ? undefined : walk(1)),
        up: () => void move(0, PAN_STEP),
        down: () => void move(0, -PAN_STEP),
      },
      { when: "notEditing", repeat: true },
    );
    return () => {
      keys();
      arrows();
    };
  });

  // The wheel: a view has no wheel event, so a tall, empty scroll view lies over the picture as a sensor. It rests in the
  // middle; each step away is converted to zoom steps (the rest kept so a trackpad's small steps add up) and it is put
  // back. The picture is never inside it: the platform draws a scroll the frame it happens, before the zoom and the reset
  // arrive, so a picture in it jumped along the wheel and back on every notch, which read as zooming in and out (owner,
  // 2026-11-09).
  let sensor: ScrollRef | undefined;
  const wheel = (offset: number) => {
    const delta = offset - SENSOR_SPAN / 2;
    if (delta === 0) return;
    sensor?.scrollTo({ y: SENSOR_SPAN / 2, animated: false });
    zoomTo(wheelZoom(scale(), -delta));
  };

  const menu = (): MenuEntry[] => [
    ...props.entries,
    "separator",
    { label: "Rotate", icon: "rotate-cw", shortcut: "R", onSelect: rotate },
  ];

  const url = () => (failure() === null ? props.url : undefined);

  return (
    <Dialog
      open
      animation="fade"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      onCancel={ask}
      class="absolute inset-0"
    >
      <PopupRoot class="flex-1">
        <View
          class="flex-1"
          onLayout={({ bounds }) => {
            box.set({ width: bounds.size.width, height: bounds.size.height });
            place(pan());
          }}
          onMouseMove={(e) => {
            chromeIdle.poke();
            pointer = { x: e.pagePosition.x - box().width / 2, y: e.pagePosition.y - box().height / 2 };
            if (e.pressedButton !== "left") {
              last = null;
              return;
            }
            if (last) move(e.pagePosition.x - last.x, e.pagePosition.y - last.y);
            last = { x: e.pagePosition.x, y: e.pagePosition.y };
          }}
          onMouseLeave={() => {
            last = null;
          }}
        >
          <View testID="dialog-scrim" focusable={false} class="absolute inset-0 bg-black/70" />
          <View class="absolute inset-0 items-center justify-center">
            <If
              when={url()}
              else={
                <View class={`max-w-md rounded-lg bg-card ${EDGE.lg}`}>
                  <Empty
                    icon="image"
                    title={props.empty?.title ?? "This picture cannot be shown"}
                    hint={props.empty?.hint ?? failure() ?? undefined}
                  />
                </View>
              }
            >
              {(src) => (
                <View
                  role="group"
                  accessibilityLabel={`Picture, ${props.name}`}
                  style={{
                    width: Math.max(1, shown().width),
                    height: Math.max(1, shown().height),
                    transform: `translate(${pan().x}px, ${pan().y}px)`,
                  }}
                >
                  {/* Drawn once at its own size and zoomed by a transform: a zoom never lays the picture out or redraws it,
                      which made a wheel zoom of a large photo lag. */}
                  <Image
                    src={src()}
                    accessibilityLabel={props.name}
                    onLoad={({ size }) => {
                      natural.set({ width: size.width, height: size.height });
                    }}
                    onError={({ message }) => failure.set(message)}
                    style={{
                      position: "absolute",
                      left: (shown().width - natural().width) / 2,
                      top: (shown().height - natural().height) / 2,
                      width: Math.max(1, natural().width),
                      height: Math.max(1, natural().height),
                      transform: `rotate(${turn()}deg) scale(${scale()})`,
                      opacity: natural().width > 0 ? 1 : 0,
                    }}
                  />
                </View>
              )}
            </If>
          </View>
          <Scroll
            ref={(node: ScrollRef) => {
              sensor = node;
            }}
            testID="lightbox-wheel"
            class="absolute inset-0"
            scrollbar={false}
            contentOffset={{ y: SENSOR_SPAN / 2 }}
            scrollEventThrottle={16}
            onScroll={(e) => wheel(e.offset.y)}
          >
            <View style={{ height: box().height + SENSOR_SPAN, paddingTop: SENSOR_SPAN / 2 }}>
              <View
                focusable={false}
                onPress={(e) => {
                  // The press lands here, over the picture: whether it is on the picture, from the window's centre.
                  const on =
                    url() !== undefined &&
                    Math.abs(e.position.x - box().width / 2 - pan().x) <= shown().width / 2 &&
                    Math.abs(e.position.y - box().height / 2 - pan().y) <= shown().height / 2;
                  if (!on) ask();
                  else if (e.clickCount === 2) toggle();
                }}
                style={{ height: box().height, cursor: draggable() ? "grab" : "default" }}
              />
            </View>
          </Scroll>

          <View style={chromeStyle} class="absolute left-4 top-4 max-w-[60%]">
            <View class={`h-8 justify-center rounded-lg bg-card/90 px-3 ${EDGE.sm}`}>
              <Clipped fade={["from-card/0 to-card"]} class="text-sm text-muted-foreground">
                {nameLine(props.name, props.names)}
              </Clipped>
            </View>
          </View>
          <View style={chromeStyle} class="absolute right-4 top-4 flex-row items-center gap-1">
            <View class={`flex-row items-center gap-1 rounded-lg bg-card/90 p-1 ${EDGE.sm}`}>
              <ActionMenu
                label="More"
                icon="ellipsis"
                entries={menu()}
                onOpenChange={(open) => chromeIdle.hold(open)}
              />
              <IconButton icon="x" label="Close" shortcut="Esc" onPress={props.onClose} />
            </View>
          </View>

          <If when={target(-1) !== undefined}>
            <View
              class={`absolute bottom-16 left-0 top-16 justify-center pl-4 ${EDGE_ZONE}`}
              onMouseEnter={() => left.set(true)}
              onMouseLeave={() => left.set(false)}
            >
              <View style={leftStyle} class="items-start">
                <Round icon="chevron-left" label="Previous photo" shortcut="Left" onPress={() => walk(-1)} />
              </View>
            </View>
          </If>
          <If when={target(1) !== undefined}>
            <View
              class={`absolute bottom-16 right-0 top-16 items-end justify-center pr-4 ${EDGE_ZONE}`}
              onMouseEnter={() => right.set(true)}
              onMouseLeave={() => right.set(false)}
            >
              <View style={rightStyle}>
                <Round icon="chevron-right" label="Next photo" shortcut="Right" onPress={() => walk(1)} />
              </View>
            </View>
          </If>

          <View style={readoutStyle} class="absolute bottom-6 left-0 right-0 items-center">
            <View class={`rounded-lg bg-card/90 px-3 py-1 ${EDGE.sm}`}>
              <Text
                style={NUM}
                class="text-xs text-muted-foreground"
                accessibilityLabel={`Zoom ${zoomPercent(scale())}`}
              >
                {zoomPercent(scale())}
              </Text>
            </View>
          </View>
        </View>
        <ToastHost dialog={id} />
      </PopupRoot>
    </Dialog>
  );
}

/** A 44-pt round button (the ladder's touch size) on the scrim, for the arrows at the window's edges. */
function Round(props: {
  icon: "chevron-left" | "chevron-right";
  label: string;
  shortcut: string;
  onPress: () => void;
}) {
  return (
    <Tipped label={props.label} shortcut={props.shortcut}>
      <Button
        onPress={props.onPress}
        accessibilityLabel={props.label}
        class={`size-11 items-center justify-center rounded-full bg-card/90 hover:bg-card ${EDGE.sm} ${FOCUS_RING}`}
      >
        <Icon name={props.icon} size={20} tone="foreground" />
      </Button>
    </Tipped>
  );
}

/** The `...` menu of a file of a folder: what can be done with it (`fileActions`), each only where it applies. */
export function fileMenu(file: {
  machine: string;
  path: string;
  name: string;
  local: boolean;
  /** The text of an SVG, copied as contents. */
  text?: string;
  /** A picture the clipboard can hold (not an SVG). */
  image?: boolean;
}): MenuEntry[] {
  const act = fileActions(file);
  return [
    { label: "Send to the agent", icon: "send", onSelect: act.send },
    ...(file.image ? [{ label: "Copy image", icon: "image" as const, onSelect: act.copyImage }] : []),
    ...(file.text !== undefined
      ? [{ label: "Copy contents", icon: "copy" as const, onSelect: () => void copyText(file.text ?? "", "Contents") }]
      : []),
    { label: "Copy path", icon: "copy", onSelect: () => void copyText(file.path, "Path") },
    { label: "Open", icon: "external-link", onSelect: act.open },
    ...(file.local ? [{ label: "Reveal", icon: "folder" as const, onSelect: act.reveal }] : []),
  ];
}

/** The `...` menu of a picture read from a chat: it has no file, so only the image itself can be copied. */
export function pictureMenu(uri: string): MenuEntry[] {
  return [
    {
      label: "Copy image",
      icon: "image",
      onSelect: () =>
        void Clipboard.writeImage(uri)
          .then(() => notify("Image copied"))
          .catch((e: unknown) =>
            notify(`Could not copy the image: ${e instanceof Error ? e.message : String(e)}`, { type: "error" }),
          ),
    },
  ];
}
