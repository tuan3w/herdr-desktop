import { Media } from "herdr-desktop/native";
import { announce, computed, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Editor } from "nsh/base";

import type { FileData } from "herdr-desktop/native";

import { CodeBlock } from "#components/code-block";
import { FileActions } from "#components/file-actions";
import { ArchiveView, BinaryView, BODY, CsvView, PdfView, PlayCard } from "#components/file-kinds";
import { ImageView } from "#components/image-view";
import { LargeText } from "#components/large-text";
import { fileMenu, Lightbox } from "#components/lightbox-view";
import { Markdown } from "#components/markdown";
import { MediaPlayer } from "#components/media-player";
import { PaneFind } from "#components/pane-find";
import { Btn, Clipped, Empty, IconButton, Segmented } from "#kit";
import { isImageName, modifiedText, parentOf, placeText, sizeText } from "#lib/files";
import { held } from "#lib/list-item";
import { registerPane } from "#lib/pane-input";

/** Characters above which a file stays in the editor: the code view builds a row per line, the editor reads a file of any size. */
const CODE_VIEW_LIMIT = 512 * 1024;
/** What a cut line fades into on a dialog (`Clipped` `fade`): the card, then a hovered row's `hover:bg-accent`. */
const CARD = "from-card/0 to-card";

/** The height of the content in the preview beside a folder's list. */
const QUICK_BODY = 300;
/** The view switch's row and the gap under it, taken from the content's height in the side panel. */
const SWITCH_ROW = 44;

/** Where the viewer steps from this file: the files of the folder it came from (the pictures, for a picture). */
export interface ViewerNav {
  names: string[];
  /** Goes to the file called `name` of the same folder. */
  go: (name: string) => void;
}

/**
 * One file, read only, by what it is: text as code (`CodeBlock`: the language its name says, line numbers, selection and
 * copy, `mod+f` to find a line, the line a link named marked and scrolled to; above 512 KB the read-only editor), Markdown
 * as a document, a table as a table, minified JSON laid out, a text file over 4 MB paged by lines with a search through
 * all of it, a picture in the lightbox (`Lightbox`), a video or a sound in the player, a PDF handed to the system's viewer, an
 * archive as a list, anything else as a hex peek. Above the content, what can be done with the file (`FileActions`).
 * Each of the views with two ways to read (a document and its source, a table and its text, formatted and as written) has
 * a switch. `quick` is the preview beside a folder's list: smaller, nothing plays, nothing is copied from another machine.
 * `panelHeight` is the side panel a link opened (`components/link-panel.tsx`): the content alone at that height, as
 * still as `quick` (the panel's header names the file and offers its tab), the switch kept.
 */
export function FileViewer(props: {
  machine: string;
  machineName: string;
  data: FileData;
  line?: number;
  onBack: () => void;
  nav?: ViewerNav;
  quick?: boolean;
  panelHeight?: number;
}) {
  const data = held(() => props.data);
  const mode = signal<"rich" | "source">("rich");
  const finding = signal(false);
  // The line shown marked and scrolled to: the one a link named, then each match of the find bar.
  const line = signal(props.line ?? 0);
  // In the panel nothing plays and nothing registers for the global keys: those stay the chat's beside it.
  const still = props.quick || props.panelHeight !== undefined;
  // In the panel the content takes the panel's height, less the view switch's row when the file has one.
  const body = () =>
    props.panelHeight !== undefined
      ? props.panelHeight - (switchable() !== null ? SWITCH_ROW : 0)
      : props.quick
        ? QUICK_BODY
        : BODY;
  // Another file in the same viewer: its own switch and find bar.
  effect(() => {
    void data().path;
    untracked(() => {
      mode.set("rich");
      finding.set(false);
    });
  });

  // Counts every request to show a line: "next hit" on the line already shown, after the reader scrolled away, sets the
  // same `line` (a signal ignores it), and the block still has to scroll back.
  const request = signal(0);
  const show = (row: number) => {
    line.set(row);
    request.set(request() + 1);
  };

  const name = () => data().name;
  const kind = () => data().kind;
  const isJson = () => /\.(json|jsonc|geojson)$/i.test(name());
  // Minified JSON is laid out for reading; a file that is not valid JSON stays as written.
  const formatted = computed(() => {
    const text = data().text;
    if (!isJson() || text === undefined || text === null || text.trim().length < 200 || text.trim().includes("\n"))
      return undefined;
    return Media.formatJson(text) ?? undefined;
  });
  const switchable = (): { rich: string; source: string } | null => {
    if (kind() === "markdown") return { rich: "Preview", source: "Source" };
    if (kind() === "csv") return { rich: "Table", source: "Text" };
    if (formatted() !== undefined) return { rich: "Formatted", source: "As written" };
    return null;
  };
  const showsText = (): string | undefined => {
    const text = data().text ?? undefined;
    if (text === undefined) return undefined;
    return formatted() !== undefined && mode() === "rich" ? formatted() : text;
  };
  const lines = () => (showsText() ?? "").split("\n");
  const code = () => (showsText() ?? "").length <= CODE_VIEW_LIMIT;
  const asDocument = () => mode() === "rich" && (kind() === "markdown" || kind() === "csv");

  // `mod+f` finds in the file while it is open: the newest registration is the one the global shortcut asks (`lib/pane-input.ts`),
  // so the pane behind the dialog does not open its own find bar too.
  effect(() => {
    if (still) return;
    return registerPane({ focusComposer: () => {}, searchInPane: () => finding.set(true) });
  });

  const place = () => (props.nav ? placeText(props.nav.names, name(), isImageName(name())) : "");
  const meta = () =>
    [place(), sizeText(data().size), modifiedText(data().modified, Math.floor(Date.now() / 1000)), props.machineName]
      .filter(Boolean)
      .join(" · ");

  const stepTo = (step: -1 | 1) => {
    const nav = props.nav;
    if (!nav) return;
    const at = nav.names.indexOf(name());
    const next = at < 0 ? undefined : nav.names[at + step];
    if (next !== undefined) nav.go(next);
  };
  const canStep = (step: -1 | 1) => {
    const nav = props.nav;
    if (!nav) return false;
    const at = nav.names.indexOf(name());
    return at >= 0 && nav.names[at + step] !== undefined;
  };
  // `[` and `]` walk the folder from any file; in the lightbox a picture answers Left and Right.
  effect(() => {
    if (props.quick || !props.nav) return;
    return keymap.bind({ "[": () => stepTo(-1), "]": () => stepTo(1) }, { when: "notEditing" });
  });
  effect(() => {
    if (!props.quick && props.nav) announce([place(), name()].filter(Boolean).join(", "));
  });
  // A picture is not a step of this view: it opens in the lightbox over it, and closing that returns to the folder.
  const lightboxed = () => !still && kind() === "image";
  const pictureMenu = computed(() =>
    fileMenu({
      machine: props.machine,
      path: data().path,
      name: name(),
      local: data().local,
      text: /\.svg$/i.test(name()) ? (data().text ?? undefined) : undefined,
      image: !/\.svg$/i.test(name()) && data().image !== undefined,
    }),
  );

  const textBody = () => (
    <View class="gap-2">
      <If when={finding() && !still}>
        <PaneFind
          what="file"
          rows={async () => lines()}
          scrollToRow={(row) => show(row + 1)}
          onClose={() => finding.set(false)}
        />
      </If>
      <If
        when={code()}
        else={
          <Editor
            ref={(editor) => {
              if (props.line) editor.goToLine(props.line);
            }}
            readOnly
            autoFocus={!still}
            language={name()}
            value={showsText() ?? ""}
            lineNumbers
            softWrap={false}
            folding={false}
            fontSize={13}
            accessibilityLabel={`${name()}, read only`}
            class="w-full rounded-md border border-border bg-card"
            style={{ height: body() }}
          />
        }
      >
        <View role="group" accessibilityLabel={`${name()}, read only`} style={{ height: body() }}>
          <CodeBlock
            code={showsText() ?? ""}
            path={name()}
            lineNumbers
            collapsedLines={0}
            maxHeight={body() - 32}
            marks={line() > 0 ? String(line()) : undefined}
            goTo={line() > 0 ? line() : undefined}
            goToNonce={request()}
          />
        </View>
      </If>
    </View>
  );

  const isKind = (...kinds: string[]) => kinds.includes(kind());
  const large = () => data().large && kind() === "text";
  const markdownHeight = () => (props.quick ? 300 : props.panelHeight !== undefined ? body() : 400);

  // One branch per kind, each reading only what decides it: a switch of the find bar or the view must not rebuild a player.
  const content = () => (
    <>
      <If when={large()}>
        <LargeText
          machine={props.machine}
          path={data().path}
          name={name()}
          height={body() - 40}
          finding={finding() && !still}
          onCloseFind={() => finding.set(false)}
        />
      </If>
      <If when={isKind("video", "audio")}>
        <If
          when={!still}
          else={
            <PlayCard name={name()} kind={kind() === "video" ? "video" : "audio"} size={data().size} height={body()} />
          }
        >
          <Each of={[data().path]} key={(path: string) => path}>
            {(path) => (
              <MediaPlayer
                machine={props.machine}
                machineName={props.machineName}
                path={path()}
                name={name()}
                kind={kind() === "video" ? "video" : "audio"}
                local={data().local}
              />
            )}
          </Each>
        </If>
      </If>
      <If when={still && isKind("image")}>
        <If
          when={data().image}
          else={
            <View style={{ height: body() }} class="items-center justify-center">
              <Empty
                fill
                icon="image"
                title="This picture is not shown"
                hint={data().notice ?? `${name()} · ${sizeText(data().size)}`}
              />
            </View>
          }
        >
          {(url) => <ImageView url={url()} name={name()} height={body()} />}
        </If>
      </If>
      <If when={isKind("pdf")}>
        <PdfView
          machine={props.machine}
          machineName={props.machineName}
          path={data().path}
          name={name()}
          size={data().size}
          height={body()}
        />
      </If>
      <If when={isKind("archive")}>
        <ArchiveView machine={props.machine} path={data().path} name={name()} height={body()} quick={still} />
      </If>
      <If when={isKind("csv") && asDocument() ? data().text : undefined}>
        {(text) => <CsvView text={text()} name={name()} height={body()} />}
      </If>
      <If when={isKind("markdown") && asDocument()}>
        <View style={{ height: markdownHeight() }}>
          <Markdown
            source={data().text ?? ""}
            machine={props.machine}
            folder={parentOf(data().path) ?? "/"}
            class="flex-1 rounded-md border border-border bg-card"
          />
        </View>
      </If>
      <If when={!large() && ((isKind("text") && true) || (isKind("markdown", "csv") && !asDocument()))}>
        {textBody()}
      </If>
      <If when={isKind("binary")}>
        <BinaryView
          machine={props.machine}
          path={data().path}
          name={name()}
          size={data().size}
          local={data().local}
          height={body()}
          quick={still}
        />
      </If>
    </>
  );

  const page = () => (
    <View class="gap-3">
      <If when={props.panelHeight === undefined || switchable() !== null}>
        <View class="flex-row items-center gap-2">
          <If when={!props.quick && props.panelHeight === undefined}>
            <Btn small icon="arrow-left" label="Files" name="Back to the folder" onPress={props.onBack} />
          </If>
          <If when={props.panelHeight === undefined} else={<View class="flex-1" />}>
            <View class="min-w-0 flex-1 gap-1">
              <Clipped fade={[CARD]} class="text-sm font-medium text-foreground">
                {name()}
              </Clipped>
              <Clipped fade={[CARD]} class="text-xs text-muted-foreground">
                {meta()}
              </Clipped>
            </View>
          </If>
          <If when={switchable() !== null && !props.quick}>
            <Segmented
              label={`${name()} view`}
              value={mode()}
              onChange={(next) => mode.set(next)}
              options={[
                { value: "rich", label: switchable()?.rich ?? "" },
                { value: "source", label: switchable()?.source ?? "" },
              ]}
            />
          </If>
          <If when={props.nav && !still}>
            <If when={canStep(-1)}>
              <IconButton icon="chevron-left" label="Previous file" shortcut="[" onPress={() => stepTo(-1)} />
            </If>
            <If when={canStep(1)}>
              <IconButton icon="chevron-right" label="Next file" shortcut="]" onPress={() => stepTo(1)} />
            </If>
          </If>
        </View>
      </If>
      <If when={!still}>
        <FileActions
          machine={props.machine}
          path={data().path}
          name={name()}
          local={data().local}
          text={data().large ? undefined : showsText()}
        />
      </If>
      <If when={data().notice && kind() !== "image"}>
        <View class="rounded-md bg-muted px-3 py-2">
          <Text class="text-sm text-foreground">{data().notice}</Text>
        </View>
      </If>
      {content()}
    </View>
  );

  return (
    <If when={lightboxed()} else={page()}>
      <Lightbox
        url={data().image ?? undefined}
        name={name()}
        names={props.nav?.names}
        go={props.nav?.go}
        entries={pictureMenu()}
        empty={
          data().image === undefined
            ? { title: "This picture is not shown", hint: data().notice ?? `${name()} · ${sizeText(data().size)}` }
            : undefined
        }
        onClose={props.onBack}
      />
    </If>
  );
}
