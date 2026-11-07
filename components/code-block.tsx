import { Code, CodeView } from "herdr-desktop/native";
import { announce, cleanup, Clipboard, computed, effect, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";

import type { CodeViewRef } from "herdr-desktop/native";

import { copyMenu, FOCUS_RING, Icon, notify, Tipped } from "#kit";
import { touched } from "#lib/code-blocks";
import { CODE_COLLAPSED_LINES, CODE_MAX_HEIGHT, codeLabel, lineCount } from "#lib/highlight";
import { hoverTransition } from "#lib/motion";
import { codeLineNumbers, codeWhitespace, codeWrap } from "#lib/settings";
import { restartable } from "#lib/timer";

/**
 * The one renderer of code in the chat: a markdown fence, a command's output, a file. A quiet surface one shade off
 * the page, the language in the corner, and on hover or keyboard focus three small tools (wrap, line numbers, copy).
 * Past `collapsedLines` it folds with a fade and `Show all N lines`; open, a long block scrolls inside itself.
 * Colours are the theme's `code-*` tokens, so nothing here names a colour.
 *
 * `streaming` is a fence that is still being written: it never folds (the end is what you are reading), follows its
 * end, and its text is highlighted as it stands. Everything the person can toggle is a setting in `lib/highlight.ts`.
 */
export function CodeBlock(props: {
  code: string;
  /** The fence's info string (`tsx`, `rust,no_run`) or a language name. Without one the language is found from `path` and the text. */
  language?: string;
  /** The file the code came from; its name finds the language. */
  path?: string;
  /** Shown in the corner instead of the language: a file name, a command. */
  title?: string;
  firstLine?: number;
  /** Lines a `file:line` reference points at: `12` or `3,7-9`. */
  marks?: string;
  streaming?: boolean;
  /** Lines shown while folded (default 16); 0 never folds. */
  collapsedLines?: number;
  /** Unfolded. Alone it is where the block starts; with `onOpenChange` it is the state the caller keeps (a recycled list cell keeps none). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Height at which an open block scrolls inside itself (default 560). */
  maxHeight?: number;
  /** No header row: the block is only its code, and the tools float over its corner on hover. For a command or an output whose kind the row around it already says. */
  compact?: boolean;
  /** Show the header's tools (default true). Off where the card around the block has its own `Copy`. */
  tools?: boolean;
  /** Line numbers fixed on or off (a file viewer needs them); without it the person's choice, with its `Lines` tool. */
  lineNumbers?: boolean;
  /** Scrolls this line (a number counted from `firstLine`) to the top when it changes; it is not marked, `marks` does that. */
  goTo?: number;
  /** Changes with every request for the same `goTo` (a "next hit" on the line the reader scrolled away from): the block scrolls again. */
  goToNonce?: number;
}) {
  const info = computed(() => Code.describe(props.code, props.language ?? null, props.path ?? null));
  const lines = computed(() => lineCount(props.code));
  const fold = () => (props.streaming ? 0 : (props.collapsedLines ?? CODE_COLLAPSED_LINES));
  const local = signal(props.open ?? false);
  const open = () => (props.onOpenChange ? (props.open ?? false) : local());
  const toggle = () => (props.onOpenChange ? props.onOpenChange(!open()) : local.set(!open()));
  const foldable = () => fold() > 0 && lines() > fold() + 2;
  const shown = () => (foldable() && !open() ? fold() : 0);
  const copied = signal(false);
  const timer = restartable();

  let view: CodeViewRef | undefined;
  const viewReady = signal(false);
  // A block that scrolls inside itself builds its list a frame or two after the block is made, and `goToLine` says
  // nothing when it came too early: ask once the view exists and again on the next two frames (frames, not a clock
  // guess), and again whenever the request is repeated (`goToNonce`).
  effect(() => {
    const line = props.goTo;
    void props.goToNonce;
    if (!line || !viewReady()) return;
    let frame = 0;
    let left = 3;
    const ask = () => {
      view?.goToLine(line);
      if (--left > 0) frame = requestAnimationFrame(ask);
    };
    ask();
    return () => cancelAnimationFrame(frame);
  });
  const numbers = () => props.lineNumbers ?? codeLineNumbers();
  const mine = () => props.code;
  cleanup(() => touched.release(mine));

  const copy = () => {
    void Clipboard.writeText(props.code).then(
      () => {
        copied.set(true);
        announce("Copied");
        timer.after(1600, () => copied.set(false));
      },
      (e) => notify(`Could not copy the code: ${e instanceof Error ? e.message : String(e)}`, { type: "error" }),
    );
  };

  const code = (
    <CodeView
      ref={(ref: CodeViewRef) => {
        view = ref;
        viewReady.set(true);
      }}
      code={props.code}
      language={props.language}
      path={props.path}
      lineNumbers={numbers()}
      firstLine={props.firstLine ?? 1}
      wrap={codeWrap()}
      whitespace={codeWhitespace()}
      marks={props.marks}
      visibleLines={shown()}
      maxHeight={props.maxHeight ?? CODE_MAX_HEIGHT}
      follow={props.streaming ?? false}
      label={codeLabel(info().language, lines())}
    />
  );

  return (
    <View
      class={`group relative w-full overflow-hidden rounded-md ${props.compact ? "py-1" : ""}`}
      style={{ backgroundColor: token("code-bg") }}
      onContextMenu={copyMenu(() => [{ label: "Copy code", onSelect: copy }])}
      onMouseEnter={() => touched.set(mine)}
      onMouseLeave={() => touched.release(mine)}
      onFocus={() => touched.set(mine)}
      onBlur={() => touched.release(mine)}
    >
      <If when={!props.compact}>
        <View class="min-h-8 flex-row items-center gap-1 pl-3 pr-1">
          <Text class="flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1, userSelect: "none" }}>
            {props.title ?? (info().language || "Text")}
          </Text>
        </View>
      </If>
      <If when={props.tools ?? true}>
        <View
          class="absolute right-1 top-1 z-10 flex-row items-center gap-1 rounded-md opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          style={{ backgroundColor: token("code-bg") }}
        >
          <Tool label="Wrap lines" text="Wrap" selected={codeWrap()} onPress={() => codeWrap.set(!codeWrap())} />
          <If when={props.lineNumbers === undefined}>
            <Tool
              label="Line numbers"
              text="Lines"
              selected={codeLineNumbers()}
              onPress={() => codeLineNumbers.set(!codeLineNumbers())}
            />
          </If>
          <Tool
            label={copied() ? "Copied" : "Copy code"}
            text={copied() ? "Copied" : "Copy"}
            icon={copied() ? "check" : "copy"}
            onPress={copy}
          />
        </View>
      </If>
      {/* One view for a block being written and for the same block finished: it reads `follow` once, when it is made, so
          a reader at the end stays there, and a second view would start again at the top. */}
      {code}
      <If when={foldable()}>
        <Button
          onPress={toggle}
          accessibilityLabel={open() ? "Show fewer lines" : `Show all ${lines()} lines`}
          style={hoverTransition()}
          class={`min-h-8 flex-row items-center justify-center gap-1 hover:bg-accent ${FOCUS_RING}`}
        >
          <Text class="text-xs font-medium text-muted-foreground" style={{ userSelect: "none" }}>
            {open() ? "Show less" : `Show all ${lines()} lines`}
          </Text>
          <If when={!open()}>
            <Icon name="chevron-down" size={14} tone="muted-foreground" />
          </If>
        </Button>
      </If>
    </View>
  );
}

/** A small text tool of a block's header: 24 pt high, quiet, named for screen readers by what it does. */
function Tool(props: {
  label: string;
  text: string;
  onPress: () => void;
  selected?: boolean;
  icon?: "copy" | "check";
}) {
  return (
    <Tipped label={props.label}>
      <Button
        onPress={props.onPress}
        accessibilityLabel={props.label}
        selected={props.selected}
        style={hoverTransition()}
        class={`min-h-7 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent selected:bg-accent ${FOCUS_RING}`}
      >
        <If when={props.icon}>{(name) => <Icon name={name()} size={14} tone="muted-foreground" />}</If>
        <Text class="text-xs text-muted-foreground" style={{ userSelect: "none" }}>
          {props.text}
        </Text>
      </Button>
    </Tipped>
  );
}

/**
 * Inline code in running text: a neutral chip, never a colour. For a `TextView`'s `code` part (`classes.code`,
 * `inlineCodeClasses`) and for a lone `Text` (`InlineCode`).
 */
export const inlineCodeClasses = "rounded-sm bg-muted font-mono text-foreground";

export function InlineCode(props: { children: string }) {
  return <Text class={`${inlineCodeClasses} px-1 text-xs`}>{props.children}</Text>;
}
