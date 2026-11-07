import { announce, effect, Image, keymap, signal, Text, View } from "nsh";

import { Btn, Empty, IconButton, NUM } from "#kit";
import { clampPan, fitScale, overflows, rotatedBy, turned, zoomed, zoomPercent } from "#lib/image-view";
import type { Pan, Size, Turn } from "#lib/image-view";

/** The pixels one arrow key pans a zoomed picture. */
const PAN_STEP = 60;

/**
 * A picture, at the size of the window or zoomed: `+` and `-` (and the two buttons) step a quarter at a time, `0` fits the
 * window, `1` is the picture's own size, `R` turns it a quarter clockwise, and a picture bigger than the window is
 * dragged with the pointer or panned with the arrow keys (at a fit the arrows go to the neighbouring picture through
 * `onStep`). The file name is the alt text, as a file has no other description. `quick` is the preview beside a folder's
 * list: the picture fitted, no tools, no keys.
 */
export function ImageView(props: {
  url: string;
  name: string;
  height: number;
  quick?: boolean;
  /** Left and Right at a fit: the previous or next picture of the folder. */
  onStep?: (step: -1 | 1) => void;
  /** The picture's size in pixels, once known. */
  onSize?: (size: Size) => void;
}) {
  const natural = signal<Size>({ width: 0, height: 0 });
  const box = signal<Size>({ width: 0, height: 0 });
  const failure = signal<string | null>(null);
  const turn = signal<Turn>(0);
  // `null` is a fit; a number is the scale the person chose.
  const chosen = signal<number | null>(null);
  const pan = signal<Pan>({ x: 0, y: 0 });
  let last: { x: number; y: number } | null = null;

  const fit = () => fitScale(natural(), turn(), box());
  const scale = () => chosen() ?? fit();
  const shown = (): Size => {
    const t = turned(natural(), turn());
    return { width: t.width * scale(), height: t.height * scale() };
  };
  const draggable = () => overflows(shown(), box());
  const place = (next: Pan) => pan.set(clampPan(next, shown(), box()));

  const setScale = (value: number | null) => {
    chosen.set(value);
    place(pan());
    announce(`Zoom ${zoomPercent(value ?? fit())}`);
  };
  const step = (direction: 1 | -1) => setScale(zoomed(scale(), direction));
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

  effect(() => {
    if (props.quick) return;
    const off = keymap.bind(
      {
        plus: () => step(1),
        minus: () => step(-1),
        "0": () => setScale(null),
        "1": () => setScale(1),
        r: rotate,
      },
      { when: "notEditing" },
    );
    // At a fit the arrows walk the folder; zoomed in they move the picture.
    const arrows = keymap.bind(
      {
        left: () => (move(PAN_STEP, 0) ? undefined : props.onStep?.(-1)),
        right: () => (move(-PAN_STEP, 0) ? undefined : props.onStep?.(1)),
        up: () => void move(0, PAN_STEP),
        down: () => void move(0, -PAN_STEP),
      },
      { when: "notEditing", repeat: true },
    );
    return () => {
      off();
      arrows();
    };
  });

  return (
    <View class="gap-2">
      <View
        role="group"
        accessibilityLabel={`${props.name}, picture`}
        style={{ height: props.height, cursor: draggable() && !props.quick ? "grab" : "default" }}
        class="items-center justify-center overflow-hidden rounded-md bg-muted"
        onLayout={({ bounds }) => {
          box.set({ width: bounds.size.width, height: bounds.size.height });
          place(pan());
        }}
        onMouseMove={(e) => {
          if (props.quick || e.pressedButton !== "left") {
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
        <If
          when={failure()}
          else={
            <Image
              src={props.url}
              accessibilityLabel={props.name}
              onLoad={({ size }) => {
                natural.set({ width: size.width, height: size.height });
                props.onSize?.({ width: size.width, height: size.height });
              }}
              onError={({ message }) => failure.set(message)}
              style={{
                width: Math.max(1, natural().width * scale()),
                height: Math.max(1, natural().height * scale()),
                transform: `translate(${pan().x}px, ${pan().y}px) rotate(${turn()}deg)`,
                opacity: natural().width > 0 ? 1 : 0,
              }}
            />
          }
        >
          {(message) => <Empty icon="image" title="This picture cannot be shown" hint={message()} />}
        </If>
      </View>
      <If when={!props.quick}>
        <View class="flex-row flex-wrap items-center gap-2" role="group" accessibilityLabel="Picture tools">
          <IconButton icon="zoom-out" label="Zoom out" shortcut="-" onPress={() => step(-1)} />
          <IconButton icon="zoom-in" label="Zoom in" shortcut="+" onPress={() => step(1)} />
          <Btn small label="Fit" name="Fit to the window" hint="0" onPress={() => setScale(null)} />
          <Btn small label="Actual size" hint="1" onPress={() => setScale(1)} />
          <IconButton icon="rotate-cw" label="Rotate" shortcut="R" onPress={rotate} />
          <Text style={NUM} class="text-xs text-muted-foreground" accessibilityLabel={`Zoom ${zoomPercent(scale())}`}>
            {zoomPercent(scale())}
          </Text>
        </View>
      </If>
    </View>
  );
}
