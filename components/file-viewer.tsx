import { Clipboard, signal, Text, View } from "nsh";
import { Editor } from "nsh/base";
import { Files } from "herdr-desktop/native";
import type { FileData } from "herdr-desktop/native";
import { modifiedText, parentOf, sizeText } from "../lib/files";
import { Btn, Clipped, Empty, notify, Segmented } from "./kit";
import { Markdown } from "./markdown";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The height of the content, so a viewer in a dialog has the room of a window and the dialog does not jump between files. */
const BODY = "h-[400px]";

/**
 * One file, read only: text in the editor with the language its name says (line numbers, find, selection and copy, no
 * typing), Markdown as a document with a switch to its source, a binary as its size, and a sentence above whatever is
 * shown when that is not the whole file (`Showing the first 4.0 MB of 18 MB`). `Reveal` and `Open` act on a file of
 * this computer only; `Copy path` is for every machine. A file that changes on disk is not followed: `Back` and
 * open it again.
 */
export function FileViewer(props: { machine: string; machineName: string; data: FileData; line?: number; onBack: () => void }) {
  const mode = signal<"preview" | "source">("preview");
  const data = () => props.data;
  const meta = () => [sizeText(data().size), modifiedText(data().modified, Math.floor(Date.now() / 1000)), props.machineName].filter(Boolean).join(" · ");
  const failed = (what: string) => (e: unknown) => notify(`${what}: ${reason(e)}`, { type: "error" });
  return (
    <View class="gap-3">
      <View class="flex-row items-center gap-2">
        <Btn small icon="arrow-left" label="Files" name="Back to the folder" onPress={props.onBack} />
        <View class="min-w-0 flex-1 gap-0.5">
          <Clipped class="text-sm font-medium text-foreground">{data().name}</Clipped>
          <Clipped class="text-xs text-muted-foreground">{meta()}</Clipped>
        </View>
        <If when={data().kind === "markdown"}>
          <Segmented
            label="Markdown view"
            value={mode()}
            onChange={(next) => mode.set(next)}
            options={[
              { value: "preview", label: "Preview" },
              { value: "source", label: "Source" },
            ]}
          />
        </If>
        <Btn small label="Copy path" icon="copy" onPress={() => void Clipboard.writeText(data().path).then(() => notify("Path copied"))} />
        <If when={data().local}>
          <Btn small label="Reveal" name="Reveal in the file manager" icon="folder" onPress={() => void Files.reveal(props.machine, data().path).catch(failed("Could not show the file"))} />
          <Btn small label="Open" name="Open with the system's application" icon="external-link" onPress={() => void Files.openExternally(props.machine, data().path).catch(failed("Could not open the file"))} />
        </If>
      </View>
      <If when={data().notice}>
        {(notice) => (
          <View class="rounded-md border border-border bg-muted px-3 py-2">
            <Text class="text-sm text-foreground">{notice()}</Text>
          </View>
        )}
      </If>
      <If
        when={data().text !== null && data().text !== undefined}
        else={
          <View class={`${BODY} items-center justify-center`}>
            <Empty fill icon="file" title={data().kind === "image" ? "This picture is not shown" : "Not a text file"} hint={`${data().name} · ${sizeText(data().size)}${data().local ? "" : ". Open it from the machine it is on."}`} />
          </View>
        }
      >
        <If
          when={data().kind === "markdown" && mode() === "preview"}
          else={
            <Editor
              ref={(editor) => {
                if (props.line) editor.goToLine(props.line);
              }}
              readOnly
              autoFocus
              language={data().name}
              value={data().text ?? ""}
              lineNumbers
              softWrap={data().kind === "markdown"}
              folding={false}
              fontSize={13}
              accessibilityLabel={`${data().name}, read only`}
              class={`${BODY} w-full rounded-md border border-border bg-card`}
            />
          }
        >
          <Markdown source={data().text ?? ""} machine={props.machine} folder={parentOf(data().path) ?? "/"} class={`${BODY} rounded-md border border-border bg-card`} />
        </If>
      </If>
    </View>
  );
}
