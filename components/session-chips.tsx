import { Image, Text, View } from "nsh";
import { Button } from "nsh/base";

import { Btn, EDGE, FOCUS_RING, FOCUS_RING_INSET, Icon, type IconName, Spinner, Tipped } from "#kit";
import type { Composer } from "#lib/composer";
import type { MentionRef, PasteRef, PictureRef, Ref } from "#lib/composer-refs";
import { fileGlyph, pictureDetail, pictureLabel } from "#lib/composer-refs";
import { browseFiles, viewFile } from "#lib/files";
import { fileName } from "#lib/session-compose";

/** The thumbnails are 56 pt: big enough to tell one screenshot from another, small enough for ten in a row. */
const THUMB = 56;

/**
 * A small round button on a chip's corner or edge that takes it off. 24 pt square for the pointer, named for what it
 * removes. Not a kit `IconButton` (32 pt, with a tooltip of its own): it sits inside a chip the tooltip already names.
 */
function RemoveButton(props: { label: string; onPress: () => void; floating?: boolean }) {
  return (
    <Button
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={`size-6 items-center justify-center rounded-full ${props.floating ? `absolute -right-2 -top-2 bg-popover ${EDGE.sm}` : "hover:bg-accent"} ${FOCUS_RING}`}
    >
      <Icon name="x" size={12} tone="muted-foreground" />
    </Button>
  );
}

/**
 * The pictures of the message as thumbnails above the box: 56 pt, rounded, a cross on each, the type and size on hover (and
 * in the name a screen reader reads: `Image 1 of 3, PNG, 1.2 MB`). Pressing one opens it in the viewer the app already has.
 * Pictures still being decoded show a placeholder each. When the agent cannot see them, a dashed edge says so on the
 * picture itself and the row under the strip says what to do.
 */
export function PictureStrip(props: { composer: Composer }) {
  const c = props.composer;
  return (
    <If when={c.pictures().length + c.preparing().length > 0}>
      <View class="gap-2">
        <View class="flex-row flex-wrap gap-3 pt-2" role="list" accessibilityLabel="Pictures in the message">
          <Each of={c.pictures()} key={(p: PictureRef) => p.id}>
            {(picture, i) => (
              <View
                role="group"
                accessibilityLabel={pictureLabel(picture(), i(), c.pictures().length)}
                style={{ width: THUMB, height: THUMB }}
              >
                <Tipped label={pictureDetail(picture())}>
                  <Button
                    accessibilityLabel={`Open ${pictureLabel(picture(), i(), c.pictures().length)}`}
                    onPress={() => viewFile("local", picture().path)}
                    style={{ width: THUMB, height: THUMB }}
                    class={`overflow-hidden rounded-lg bg-muted ${c.blind() ? "border border-dashed border-muted-foreground" : "border border-border"} ${FOCUS_RING}`}
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
                class="items-center justify-center rounded-lg border border-dashed border-border bg-muted"
              >
                <Spinner size={16} tone="muted-foreground" />
              </View>
            )}
          </Each>
        </View>
        <If when={c.notice() !== null}>
          <View class="flex-row flex-wrap items-center gap-2">
            <Icon name="alert" size={14} tone="muted-foreground" />
            <Text role="alert" class="text-xs text-muted-foreground">
              {c.notice()}
            </Text>
            <Btn
              small
              variant="outline"
              label="Save to the project and mention the path"
              onPress={() => void c.saveToProject()}
            />
          </View>
        </If>
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
