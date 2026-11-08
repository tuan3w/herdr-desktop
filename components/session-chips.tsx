import { Image, Text, View } from "nsh";
import { Button } from "nsh/base";

import { EDGE, FOCUS_RING, FOCUS_RING_INSET, Icon, type IconName, Spinner, Tipped } from "#kit";
import type { Composer } from "#lib/composer";
import type { MentionRef, PasteRef, PictureRef, Ref } from "#lib/composer-refs";
import { pictureDetail, pictureLabel } from "#lib/composer-refs";
import { fileGlyph } from "#lib/files";
import { browseFiles, viewFile } from "#lib/open-files";
import { fileName } from "#lib/session-compose";

/** The thumbnails are 72 pt cards: big enough to read what a screenshot is, small enough for a row of them. */
const THUMB = 72;

/**
 * A small round button that takes a chip off: on a picture card it sits in the reserved top right corner and shows with
 * the pointer or the focus on the card (`group`), so nothing moves. 24 pt square for the pointer, named for what it removes. Not a kit `IconButton` (32 pt, with a tooltip of its own): it sits inside a chip the tooltip already names.
 */
function RemoveButton(props: { label: string; onPress: () => void; floating?: boolean }) {
  return (
    <Button
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={`size-7 items-center justify-center rounded-full ${props.floating ? `absolute right-1 top-1 bg-popover opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 ${EDGE.sm}` : "hover:bg-accent"} ${FOCUS_RING}`}
    >
      <Icon name="x" size={12} tone="muted-foreground" />
    </Button>
  );
}

/**
 * The pictures of the message as cards inside the box above the text: 72 pt, radius nested in the box's (16 less 8 padding), a cross in the corner on hover or focus, the type and size on hover (and
 * in the name a screen reader reads: `Image 1 of 3, PNG, 1.2 MB`). Pressing one opens it in the viewer the app already has.
 * Pictures still being decoded show a placeholder each. When the agent cannot see them, a dashed edge says so on the
 * picture itself and the row under the strip says what to do.
 */
export function PictureStrip(props: { composer: Composer }) {
  const c = props.composer;
  return (
    <If when={c.pictures().length + c.preparing().length > 0}>
      <View class="gap-2">
        <View class="flex-row flex-wrap gap-2" role="list" accessibilityLabel="Pictures in the message">
          <Each of={c.pictures()} key={(p: PictureRef) => p.id}>
            {(picture, i) => (
              <View
                role="group"
                accessibilityLabel={pictureLabel(picture(), i(), c.pictures().length)}
                style={{ width: THUMB, height: THUMB }}
                class="group"
              >
                <Tipped label={pictureDetail(picture())}>
                  <Button
                    accessibilityLabel={`Open ${pictureLabel(picture(), i(), c.pictures().length)}`}
                    onPress={() => viewFile("local", picture().path)}
                    style={{ width: THUMB, height: THUMB }}
                    class={`overflow-hidden rounded-md bg-muted border border-border ${FOCUS_RING}`}
                  >
                    <Image
                      src={`data:image/jpeg;base64,${picture().thumb}`}
                      style={{ width: THUMB, height: THUMB, objectFit: "cover" }}
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    />
                  </Button>
                </Tipped>
                <RemoveButton
                  floating
                  label={`Remove image ${picture().number}`}
                  onPress={() => c.removeRef(picture())}
                />
              </View>
            )}
          </Each>
          <Each of={c.preparing()} key={(p: { id: string; name: string }) => p.id}>
            {(pending) => (
              <View
                role="group"
                accessibilityLabel={`Preparing ${pending().name}`}
                style={{ width: THUMB, height: THUMB }}
                class="items-center justify-center rounded-md border border-dashed border-border bg-muted"
              >
                <Spinner size={16} tone="muted-foreground" />
              </View>
            )}
          </Each>
        </View>
      </View>
    </If>
  );
}

/** One chip: a shape for the kind, the name (the path in the tooltip), a cross. `press` is what the name does. */
function Chip(props: {
  glyph: IconName;
  text: string;
  tip: string;
  label: string;
  removeLabel: string;
  onPress?: () => void;
  onRemove: () => void;
}) {
  return (
    <View role="group" accessibilityLabel={props.label} class="h-7 flex-row items-center rounded-md bg-muted pl-2">
      <Tipped label={props.tip}>
        <Button
          accessibilityLabel={props.label}
          onPress={() => props.onPress?.()}
          class={`h-7 flex-row items-center gap-2 rounded-sm ${FOCUS_RING_INSET}`}
        >
          <Icon name={props.glyph} size={12} tone="muted-foreground" />
          <Text class="max-w-[220px] text-xs text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {props.text}
          </Text>
        </Button>
      </Tipped>
      <RemoveButton label={props.removeLabel} onPress={props.onRemove} />
    </View>
  );
}

const mentionsOf = (refs: Ref[]): MentionRef[] => refs.filter((r): r is MentionRef => r.kind === "mention");
const pastesOf = (refs: Ref[]): PasteRef[] => refs.filter((r): r is PasteRef => r.kind === "paste");

/**
 * The files, folders and long pastes of the message as chips above the box. A mention is also in the words
 * (`@src/main.rs`); pressing its chip opens the file in the viewer (a folder in the browser), a pasted text goes back
 * into the box whole, and a file added with `+` from outside the project is only a chip. Pictures have their own strip.
 */
export function ChipRow(props: { composer: Composer; machine: string }) {
  const c = props.composer;
  return (
    <If when={mentionsOf(c.chips()).length + pastesOf(c.chips()).length + c.attached().length > 0}>
      <View class="flex-row flex-wrap gap-2 pt-1" role="list" accessibilityLabel="Files and text in the message">
        <Each of={mentionsOf(c.chips())} key={(r: MentionRef) => r.path}>
          {(ref) => (
            <Chip
              glyph={fileGlyph(fileName(ref().rel), ref().folder)}
              text={`${ref().rel}${ref().folder ? "/" : ""}`}
              tip={ref().path}
              label={`${ref().folder ? "Folder" : "File"} ${ref().rel}`}
              removeLabel={`Remove ${ref().rel}`}
              onPress={() =>
                ref().folder ? browseFiles(props.machine, ref().path) : viewFile(props.machine, ref().path)
              }
              onRemove={() => c.removeRef(ref())}
            />
          )}
        </Each>
        <Each of={pastesOf(c.chips())} key={(r: PasteRef) => r.id}>
          {(ref) => (
            <Chip
              glyph="list"
              text={`Pasted text (${ref().lines} lines)`}
              tip="Press to put the whole text back in the box"
              label={`Pasted text, ${ref().lines} ${ref().lines === 1 ? "line" : "lines"}. Press to put it back in the box`}
              removeLabel={`Remove pasted text ${ref().number}`}
              onPress={() => c.expandPaste(ref())}
              onRemove={() => c.removeRef(ref())}
            />
          )}
        </Each>
        <Each of={c.attached()} key={(p: string) => p}>
          {(path) => (
            <Chip
              glyph={fileGlyph(fileName(path()), false)}
              text={fileName(path())}
              tip={path()}
              label={`File ${fileName(path())}`}
              removeLabel={`Remove ${fileName(path())}`}
              onRemove={() => c.removeAttached(path())}
            />
          )}
        </Each>
      </View>
    </If>
  );
}
