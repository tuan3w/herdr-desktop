import { openUrl, Scroll, Text, View } from "nsh";
import { Button, TextView, type TextViewCustomNode, type TextViewImage } from "nsh/base";
import { Icon, notify } from "./kit";
import { MermaidBlock } from "./mermaid-block";
import { openLink } from "./links-dialog";

/** Fenced blocks of this language are custom nodes: the diagram, not a block of code. Every other fence is TextView's own. */
const EXTENSIONS = [{ name: "mermaid", language: "mermaid" }];

/**
 * Markdown as it sits inside a page or a chat row, without a scroll view of its own: headings, lists, tables, task lists,
 * quotes and code as `TextView` draws them, and ```` ```mermaid ```` blocks as diagrams (`MermaidBlock`). Only `http` and
 * `https` links open, in the browser; a relative path opens in the file viewer, looked for in `folder` and the two above
 * it on `machine`; anchors and anything else do nothing. An image is never fetched: it is a chip `Image: <alt>` that opens
 * the picture when its address is a path. The text is selectable and copyable. `streaming` is for text still arriving: its
 * unfinished end (`**bold`, an open fence) is drawn as if it were closed.
 *
 * The whole view is one selectable area (`selectable`), in a chat's recycled `List` cell too: the crash that once made that
 * look unsafe was a preloaded allocator, not a `TextView` (`docs/upstream/nsh-selectable-textview-in-list.md`).
 */
export function MarkdownText(props: { source: string; machine: string; folder: string; streaming?: boolean; class?: string }) {
  const press = (target: string) => {
    const path = target.split("#")[0];
    if (/^https?:\/\//i.test(target)) {
      void openUrl(target).then(
        ({ opened }) => {
          if (!opened) notify("Nothing on this computer opens that address", { type: "error" });
        },
        (e) => notify(`Could not open the address: ${e instanceof Error ? e.message : String(e)}`, { type: "error" }),
      );
    } else if (path !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(path)) {
      void openLink("path", decodeURI(path), null, null, { machine: props.machine, cwd: props.folder });
    }
  };
  const image = (img: TextViewImage) => {
    const local = !/^[a-z][a-z0-9+.-]*:/i.test(img.src);
    const name = img.alt || img.src.split("/").pop() || "image";
    return (
      <Button
        accessibilityLabel={`Image: ${name}`}
        onPress={() => (local ? press(img.src) : notify(`${img.src} is on the web and is not loaded`))}
        class="my-1 flex-row items-center gap-2 self-start rounded-md border border-border bg-muted px-2 py-1 hover:bg-accent"
      >
        <Icon name="image" size={14} tone="muted-foreground" />
        <Text class="text-sm text-foreground">{`Image: ${name}`}</Text>
      </Button>
    );
  };
  const custom = (node: TextViewCustomNode) => (node.name === "mermaid" ? <MermaidBlock code={node.text ?? ""} /> : <Text>{node.text ?? ""}</Text>);
  return (
    <TextView
      markdown={props.source}
      options={{ streaming: props.streaming ?? false }}
      class={props.class}
      selectable
      extensions={EXTENSIONS}
      renderCustom={custom}
      renderImage={image}
      onLinkPress={({ url }) => press(url)}
    />
  );
}

/** A Markdown document as a page: `MarkdownText` in a scroll view with room around it. */
export function Markdown(props: { source: string; machine: string; folder: string; class?: string }) {
  return (
    <Scroll class={props.class} contentClass="px-5 py-4">
      <MarkdownText source={props.source} machine={props.machine} folder={props.folder} />
    </Scroll>
  );
}
