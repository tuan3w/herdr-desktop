import { Image, signal, View } from "nsh";

import { Empty } from "#kit";
import { fitScale } from "#lib/image-view";
import type { Size } from "#lib/image-view";

/**
 * The preview of a picture beside a folder's list, and a picture in the side panel: fitted to its box, no tools and no
 * keys. The picture itself opens in the lightbox (`components/lightbox-view.tsx`). The file name is the alt text, as a
 * file has no other description. `onSize` hears its pixel size once it is drawn.
 */
export function ImageView(props: { url: string; name: string; height: number; onSize?: (size: Size) => void }) {
  const natural = signal<Size>({ width: 0, height: 0 });
  const box = signal<Size>({ width: 0, height: 0 });
  const failure = signal<string | null>(null);
  const scale = () => fitScale(natural(), 0, box());

  return (
    <View
      role="group"
      accessibilityLabel={`${props.name}, picture`}
      style={{ height: props.height }}
      class="items-center justify-center overflow-hidden rounded-md bg-muted"
      onLayout={({ bounds }) => box.set({ width: bounds.size.width, height: bounds.size.height })}
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
              opacity: natural().width > 0 ? 1 : 0,
            }}
          />
        }
      >
        {(message) => <Empty icon="image" title="This picture cannot be shown" hint={message()} />}
      </If>
    </View>
  );
}
