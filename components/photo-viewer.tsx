import { announce, Clipboard, effect, Image, keymap, signal, Text, untracked, View } from "nsh";
import { Files } from "herdr-desktop/native";
import { Btn, Modal, notify, Spinner } from "#kit";

/** One picture of a folder: the machine it is on, its path and its name (also its alt text: a file has no other description). */
export interface Photo {
  machine: string;
  path: string;
  name: string;
  /** Whether the picture is on this computer: only then can it be revealed in the file manager. */
  local: boolean;
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The one viewer for every picture: a dialog with the picture at the size of the window, `Photo 3 of 12` in its
 * description, Left and Right (and the two buttons) to the previous and next picture of the folder, Escape to close.
 * The picture is read when it is shown (a remote one is copied to this computer first, up to 40 MB) and a failure
 * says why in the dialog. The name is the picture's alt text for screen readers. Zoom is not offered.
 *
 * `photos` is the pictures of one folder in the order the browser lists them; `null` closes the dialog.
 */
export function PhotoViewer(props: { photos: Photo[] | null; index: number; machineName: string; onIndex: (index: number) => void; onClose: () => void }) {
  const url = signal<string | null>(null);
  const failure = signal<string | null>(null);
  const size = signal("");
  let shown = 0;

  const count = () => props.photos?.length ?? 0;
  const photo = () => props.photos?.[props.index];
  const where = () => `Photo ${props.index + 1} of ${count()}`;
  const move = (step: number) => {
    const next = props.index + step;
    if (next >= 0 && next < count()) props.onIndex(next);
  };

  // Each picture is read when it comes up; an answer for a picture the person already left is dropped.
  effect(() => {
    const now = photo();
    if (!now) return;
    const mine = ++shown;
    untracked(() => {
      url.set(null);
      failure.set(null);
      size.set("");
    });
    Files.open(now.machine, now.path).then(
      (data) => {
        if (mine !== shown) return;
        if (data.image) url.set(data.image);
        else failure.set(data.notice ?? "This picture cannot be shown");
        announce(`${now.name}, ${where()}`);
      },
      (e) => {
        if (mine !== shown) return;
        failure.set(reason(e));
        announce(reason(e));
      },
    );
  });
  effect(() => {
    if (!props.photos) return;
    const unbind = [keymap.bind("left", () => move(-1)), keymap.bind("right", () => move(1))];
    return () => unbind.forEach((off) => off());
  });

  return (
    <Modal
      open={props.photos !== null}
      huge
      onClose={() => props.onClose()}
      title={photo()?.name ?? "Picture"}
      description={[where(), size(), props.machineName].filter(Boolean).join(" · ")}
      actions={
        <>
          <Btn variant="ghost" label="Copy path" onPress={() => void Clipboard.writeText(photo()?.path ?? "").then(() => notify("Path copied"))} />
          <If when={photo()?.local}>
            <Btn variant="ghost" label="Reveal" name="Reveal in the file manager" onPress={() => void Files.reveal(photo()!.machine, photo()!.path).catch((e) => notify(`Could not show the file: ${reason(e)}`, { type: "error" }))} />
          </If>
          <Btn label="Close" hint="Esc" onPress={() => props.onClose()} />
        </>
      }
    >
      <View class="gap-2">
        <View class="h-[400px] items-center justify-center overflow-hidden rounded-md bg-muted">
          <If
            when={url()}
            else={
              <If when={failure()} else={<Spinner />}>
                {(message) => (
                  <View role="alert" class="px-6">
                    <Text class="text-center text-sm text-foreground">{message()}</Text>
                  </View>
                )}
              </If>
            }
          >
            {(src) => (
              <Image
                src={src()}
                accessibilityLabel={`${photo()?.name ?? "Picture"}, ${where()}`}
                onLoad={({ size: s }) => size.set(`${s.width} × ${s.height}`)}
                onError={({ message }) => failure.set(message)}
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            )}
          </If>
        </View>
        <View class="flex-row items-center justify-center gap-3">
          <Btn small icon="chevron-left" label="Previous" name="Previous photo" disabled={props.index <= 0} onPress={() => move(-1)} />
          <Text class="text-sm text-muted-foreground">{where()}</Text>
          <Btn small icon="chevron-right" label="Next" name="Next photo" disabled={props.index >= count() - 1} onPress={() => move(1)} />
        </View>
      </View>
    </Modal>
  );
}
