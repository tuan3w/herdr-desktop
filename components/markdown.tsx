import { computed, Scroll, Text, View } from "nsh";
import { TextView, type TextViewCodeBlock, type TextViewCustomNode, type TextViewImage } from "nsh/base";

import { ChatPicture, modHeld } from "#components/chat-picture";
import { CodeBlock, inlineCodeClasses } from "#components/code-block";
import { MermaidBlock } from "#components/mermaid-block";
import { openLink } from "#components/open-link";
import { type CopyEntry, copyMenu, copyText, Icon } from "#kit";
import type { LinkPanel } from "#lib/link-panel";
import { chatMarkdown, isPath, MARK, MENTION, pathLink } from "#lib/links";
import {
  fenceLanguage,
  type FenceSegment,
  type ProseSegment,
  type Segment,
  splitFences,
  streamTail,
} from "#lib/markdown-fences";
import { tally } from "#lib/perf-counts";
import { plainText } from "#lib/plain-text";
import { Lru, MARKDOWN_ENTRIES } from "#lib/render-cache";
import { safeCode } from "#lib/visible-text";

/** A mermaid fence inside a list item or a quote is a custom node: the diagram, not a block of code. (Top-level ones are split out by `splitFences`.) */
const EXTENSIONS = [{ name: "mermaid", language: "mermaid" }];

/** Lines of a fence being written that are drawn (`streamTail`): under the code block's cap, so it is a plain column. */
const WRITTEN_LINES = 12;

/**
 * A table the way the kit draws one: a hairline under each row and nothing else. `TextView` gives every cell a right and
 * bottom line, the grid a top and left one and the header row a filled band; the cells drop their right line, the header
 * its fill, and the wrapper clips the grid's top and left line by pulling the scroll view one point up and left
 * (emil-surfaces: one edge, never two).
 */
const TABLE_CLASSES = {
  // Links read in the text's colour with the text view's light underline: colour stays for what needs the person.
  link: "text-foreground",
  table: "overflow-hidden",
  tableScroll: "-ml-px -mt-px",
  tableHead: "bg-transparent",
  tableCell: "border-r-0",
  tableHeaderCell: "font-medium",
};

/**
 * The parts the text view sizes on its own, at the message's size (`size`): the page's 14 pt, or 13 inside a bubble. The
 * rest of a short link's path (`small`, `lib/links.ts`) is muted at the text's size, not underlined.
 */
const TEXT_PARTS = {
  base: { paragraph: "text-base", listMarker: "text-base", small: "text-base text-muted-foreground no-underline" },
  sm: { paragraph: "text-sm", listMarker: "text-sm", small: "text-sm text-muted-foreground no-underline" },
};

/** The parts of messages read lately, by their text: a recycled cell shown a message again does not split it again. */
const PARTS = new Lru<string, Segment[]>(MARKDOWN_ENTRIES);
/** Prose as drawn (`chatMarkdown`: short links, named pictures), by its text, for the same reason. */
const SHOWN = new Lru<string, string>(MARKDOWN_ENTRIES);

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
 * chip, never a colour (`inlineCodeClasses`).
 *
 * Links and pictures (`design/chat.md`, "Links and pictures"): a link whose text is its own address is drawn short
 * (`chatMarkdown`); a press goes through `openLink`, into `links` (the side panel) when there is one and `mod` is not
 * held, else the old way; a relative path is looked for in `folder` and the two above it on `machine`; anchors and other
 * schemes do nothing. A picture of the machine is a thumbnail (`ChatPicture`), a web picture a chip that is never fetched.
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
  /** The side panel a pressed link or picture opens in; without one, links open the old way. */
  links?: LinkPanel;
  /** What the right-click menu offers; by default `Copy text` and `Copy as Markdown`. */
  entries?: () => readonly CopyEntry[];
  /** The text's size: the page's (`base`, the default) or a bubble's (`sm`). */
  size?: "base" | "sm";
}) {
  // `TextView` reports a link without the keys held: the pointer's last move over the text says whether `mod` is down
  // (a move is also reported when a modifier changes under a still pointer).
  let external = false;
  const at = () => ({ machine: props.machine, cwd: props.folder, panel: props.links, external });
  const press = (target: string) => {
    if (/^https?:\/\//i.test(target)) {
      void openLink("url", target, null, null, at());
      return;
    }
    if (!isPath(target)) return;
    let decoded = target;
    try {
      decoded = decodeURI(target);
    } catch {
      // A malformed escape is looked for as written.
    }
    const { path, line, col } = pathLink(decoded);
    void openLink("path", path, line, col, at());
  };
  const image = (img: TextViewImage) => {
    // The mark before a short link: the text view wraps it in the link, named by the whole address. Its gap is padding,
    // not a space, so no underline runs under it.
    if (img.src.startsWith(MARK))
      return (
        <View class="pr-1">
          <Icon name={img.src === `${MARK}file` ? "file" : "link"} size={12} tone="muted-foreground" />
        </View>
      );
    return (
      <ChatPicture
        src={img.src}
        alt={img.alt ?? ""}
        mention={img.title === MENTION}
        at={{ machine: props.machine, folder: props.folder, links: props.links }}
      />
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
  // A message still being written changes with every chunk: it is split as it stands and not kept.
  const split = (source: string) => {
    tally("md.split");
    return splitFences(source);
  };
  const parts = computed(() => {
    const source = props.source;
    return props.streaming ? split(source) : PARTS.get(source, () => split(source));
  });
  const last = () => parts().at(-1)?.key;
  const streaming = () => props.streaming ?? false;
  return (
    <View
      selectable
      class="gap-3"
      onMouseMove={(e) => (external = modHeld(e))}
      onMouseLeave={() => (external = false)}
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
          // A fence still being written shows its tail only; whole, it is the block as ever (`streamTail`).
          const written = () => {
            const f = code();
            return f !== undefined && f.open && streaming() ? streamTail(f.code, WRITTEN_LINES) : undefined;
          };
          const foldKey = () => `${props.foldKey ?? "fence"}:${part().key}`;
          return (
            <View>
              <If when={prose()}>
                {(text) => (
                  <TextView
                    markdown={
                      streaming() && part().key === last()
                        ? chatMarkdown(text().text)
                        : SHOWN.get(text().text, () => chatMarkdown(text().text))
                    }
                    options={{ streaming: streaming() && part().key === last() }}
                    class={`${props.size === "sm" ? "text-sm" : "text-base"} text-foreground ${props.class ?? ""}`}
                    classes={{ code: inlineCodeClasses, ...TABLE_CLASSES, ...TEXT_PARTS[props.size ?? "base"] }}
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
                    code={safeCode(written()?.code ?? f().code)}
                    firstLine={1 + (written()?.skipped ?? 0)}
                    language={f().infoComplete && f().info !== "" ? f().info : undefined}
                    title={f().title}
                    collapsedLines={written() ? 0 : undefined}
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
