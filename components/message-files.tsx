import { Text, View } from "nsh";

import { PictureTile, type PictureContext } from "#components/chat-picture";
import { openLink } from "#components/open-link";
import { FOCUS_RING, Icon, Tipped } from "#kit";
import { fileGlyph } from "#lib/files";
import { pathLink } from "#lib/links";
import type { MessageFile } from "#lib/message-files";
import { modHeld } from "#lib/shortcuts";

/**
 * The files the person's own message carries (`messageFiles`), under its words in the bubble: the pictures as a row of
 * square tiles (`PictureTile`), then every other file as a chip, its glyph and name, the whole path its tooltip. A press
 * opens it in the chat's side panel (a folder in the Files tab), found as a link of the chat is: in the session's folder,
 * then its checkout and project. As herdr-mobile draws a message's pictures and file links under its text.
 */
export function MessageFiles(props: { files: readonly MessageFile[]; at: PictureContext; under?: boolean }) {
  const pictures = () => props.files.filter((f) => f.picture);
  const others = () => props.files.filter((f) => !f.picture);
  return (
    <View class={`gap-2 ${props.under ? "pt-2" : ""}`}>
      <If when={pictures().length > 0}>
        <View class="flex-row flex-wrap gap-2">
          <Each of={pictures()} key={(f: MessageFile) => f.path}>
            {(f) => <PictureTile path={f().path} name={f().name} at={props.at} />}
          </Each>
        </View>
      </If>
      <If when={others().length > 0}>
        <View class="flex-row flex-wrap gap-2">
          <Each of={others()} key={(f: MessageFile) => f.path}>
            {(f) => {
              const link = () => pathLink(f().path);
              return (
                <Tipped label={f().path} side="top">
                  <View
                    role="button"
                    accessibilityLabel={`${f().folder ? "Folder" : "File"} ${f().name}`}
                    onPress={(e) =>
                      void openLink("path", link().path, link().line, link().col, {
                        machine: props.at.machine,
                        cwd: props.at.folder,
                        panel: props.at.links,
                        external: modHeld(e),
                      })
                    }
                    class={`h-8 max-w-[320px] flex-row items-center gap-2 rounded-md border border-border bg-background px-2 hover:bg-accent ${FOCUS_RING}`}
                  >
                    <Icon name={fileGlyph(f().name, f().folder)} size={14} tone="muted-foreground" />
                    <Text
                      class="min-w-0 text-sm text-foreground"
                      style={{ numberOfLines: 1, textOverflow: "ellipsis" }}
                    >
                      {f().name}
                    </Text>
                  </View>
                </Tipped>
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}
