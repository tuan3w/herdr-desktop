import { computed, openUrl, Scroll, Text, View } from "nsh";
import { Button, TextView, type TextViewCodeBlock, type TextViewCustomNode, type TextViewImage } from "nsh/base";

import { CodeBlock, inlineCodeClasses } from "#components/code-block";
import { openLink } from "#components/links-dialog";
import { MermaidBlock } from "#components/mermaid-block";
import { type CopyEntry, copyMenu, copyText, Icon, notify } from "#kit";
import { fenceLanguage, type FenceSegment, type ProseSegment, type Segment, splitFences } from "#lib/markdown-fences";
import { plainText } from "#lib/plain-text";
import { safeCode } from "#lib/visible-text";

/** A mermaid fence inside a list item or a quote is a custom node: the diagram, not a block of code. (Top-level ones are split out by `splitFences`.) */
const EXTENSIONS = [{ name: "mermaid", language: "mermaid" }];

/**
 * Where the open or folded state of a message's code blocks lives, when the caller keeps it (a chat's recycled list cell
 * must not): `get` answers `undefined` for a block nobody has toggled.
 */
export interface Folds {
  get(key: string): boolean | undefined;
  set(key: string, open: boolean): void;
}

/**
 * Markdown as it sits inside a page or a chat row, without a scroll view of its own: headings, lists, tables, task lists
 * and quotes as `TextView` draws them, every top-level fenced block as a `CodeBlock` (highlighted, with its language,
 * `Copy code`, folding; a fence without a language is read from its text) and ```` ```mermaid ```` blocks as diagrams
 * (`MermaidBlock`). A fence inside a list item or a quote is drawn by `TextView`'s code-block hook, also as a `CodeBlock`
 * (its fold state is its own: the hook makes it again whenever its text view's text changes). Inline code is a neutral
 * chip, never a colour (`inlineCodeClasses`). Only `http` and `https` links open, in the browser; a relative path opens in the file
 * viewer, looked for in `folder` and the two above it on `machine`; anchors and anything else do nothing. An image is
 * never fetched: it is a chip `Image: <alt>` that opens the picture when its address is a path.
 *
 * `streaming` is for text still arriving: the unfinished end of the last prose part (`**bold`) is drawn as if closed, and
 * an open fence is a block that follows its end and is highlighted as it stands. Each part keeps its place while the text
 * grows (the keys of `splitFences`), so a streamed message rebinds the part being written and leaves the rest alone.
 *
 * The whole view is one selectable area (`selectable`): a drag crosses paragraphs, code and tables, in a chat's recycled
 * `List` cell too (the crash that once made that look unsafe was a preloaded allocator, not a `TextView`:
 * `docs/upstream/nsh-selectable-textview-in-list.md`).
 */
export function MarkdownText(props: {
  source: string;
  machine: string;
  folder: string;
  streaming?: boolean;
  class?: string;
  folds?: Folds;
  foldKey?: string;
  /** What the right-click menu offers; by default `Copy text` and `Copy as Markdown`. */
  entries?: () => readonly CopyEntry[];
}) {
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
  const custom = (node: TextViewCustomNode) =>
    node.name === "mermaid" ? <MermaidBlock code={node.text ?? ""} /> : <Text>{node.text ?? ""}</Text>;
  // Top-level fences are split out below; what reaches the text view's own code block is a fence inside a list item or a quote.
  const nested = (block: TextViewCodeBlock) => (
    <CodeBlock
      code={safeCode(block.code)}
      language={block.language ? `${block.language} ${block.meta ?? ""}`.trim() : undefined}
    />
  );
  const parts = computed(() => splitFences(props.source));
  const last = () => parts().at(-1)?.key;
  const streaming = () => props.streaming ?? false;
  return (
    <View
      selectable
      class="gap-3"
      onContextMenu={copyMenu(
        props.entries ??
          (() => [
            { label: "Copy text", onSelect: () => void copyText(plainText(props.source), "Text") },
            { label: "Copy as Markdown", onSelect: () => void copyText(props.source, "Markdown") },
          ]),
      )}
    >
      <Each of={parts()} key={(p: Segment) => p.key}>
        {(part) => {
          const prose = () => (part().kind === "prose" ? (part() as ProseSegment) : undefined);
          const fence = () => (part().kind === "fence" ? (part() as FenceSegment) : undefined);
          const diagram = () => {
            const f = fence();
            return f !== undefined && fenceLanguage(f.info) === "mermaid" ? f : undefined;
          };
          const code = () => {
            const f = fence();
            return f !== undefined && fenceLanguage(f.info) !== "mermaid" ? f : undefined;
          };
          const foldKey = () => `${props.foldKey ?? "fence"}:${part().key}`;
          return (
            <View>
              <If when={prose()}>
                {(text) => (
                  <TextView
                    markdown={text().text}
                    options={{ streaming: streaming() && part().key === last() }}
                    class={props.class}
                    classes={{ code: inlineCodeClasses }}
                    selectable
                    extensions={EXTENSIONS}
                    renderCustom={custom}
                    renderCodeBlock={nested}
                    renderImage={image}
                    onLinkPress={({ url }) => press(url)}
                  />
                )}
              </If>
              <If when={diagram()}>{(f) => <MermaidBlock code={safeCode(f().code)} />}</If>
              <If when={code()}>
                {(f) => (
                  <CodeBlock
                    code={safeCode(f().code)}
                    language={f().infoComplete && f().info !== "" ? f().info : undefined}
                    title={f().title}
                    streaming={streaming() && f().open}
                    open={props.folds?.get(foldKey())}
                    onOpenChange={props.folds ? (open) => props.folds!.set(foldKey(), open) : undefined}
                  />
                )}
              </If>
            </View>
          );
        }}
      </Each>
    </View>
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
