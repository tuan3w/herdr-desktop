import { announce, Clipboard, computed, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";
import { Code, CodeView } from "herdr-desktop/native";
import { CODE_COLLAPSED_LINES, CODE_MAX_HEIGHT, codeLabel, codeLineNumbers, codeWhitespace, codeWrap, lineCount } from "#lib/highlight";
import { restartable } from "#lib/timer";
import { FOCUS_RING, Icon, Tipped } from "#kit";

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
  /** Start unfolded. */
  open?: boolean;
  /** Height at which an open block scrolls inside itself (default 560). */
  maxHeight?: number;
}) {
  const info = computed(() => Code.describe(props.code, props.language ?? null, props.path ?? null));
  const lines = computed(() => lineCount(props.code));
  const fold = () => (props.streaming ? 0 : (props.collapsedLines ?? CODE_COLLAPSED_LINES));
  const open = signal(props.open ?? false);
  const foldable = () => fold() > 0 && lines() > fold() + 2;
  const shown = () => (foldable() && !open() ? fold() : 0);
  const copied = signal(false);
  const timer = restartable();

  const copy = () => {
    void Clipboard.writeText(props.code).then(() => {
      copied.set(true);
      announce("Copied");
      timer.after(1600, () => copied.set(false));
    });
  };

  const code = (streaming: boolean) => (
    <CodeView
      code={props.code}
      language={props.language}
      path={props.path}
      lineNumbers={codeLineNumbers()}
      firstLine={props.firstLine ?? 1}
      wrap={codeWrap()}
      whitespace={codeWhitespace()}
      marks={props.marks}
      visibleLines={shown()}
      maxHeight={props.maxHeight ?? CODE_MAX_HEIGHT}
      follow={streaming}
      label={codeLabel(info().language, lines())}
    />
  );

  return (
    <View class="group w-full overflow-hidden rounded-md" style={{ backgroundColor: token("code-bg") }}>
      <View class="relative min-h-8 flex-row items-center gap-1 pl-3 pr-1">
        <Text class="flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
          {props.title ?? (info().language || "Text")}
        </Text>
        <View class="absolute right-1 top-1 flex-row items-center gap-1 rounded-md opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" style={{ backgroundColor: token("code-bg") }}>
          <Tool label="Wrap lines" text="Wrap" selected={codeWrap()} onPress={() => codeWrap.set(!codeWrap())} />
          <Tool label="Line numbers" text="Lines" selected={codeLineNumbers()} onPress={() => codeLineNumbers.set(!codeLineNumbers())} />
          <Tool label={copied() ? "Copied" : "Copy code"} text={copied() ? "Copied" : "Copy"} icon={copied() ? "check" : "copy"} onPress={copy} />
        </View>
      </View>
      {/* Written and finished are two views on purpose: the first follows its end, the second starts at the top. */}
      <If when={props.streaming}>{code(true)}</If>
      <If when={!props.streaming}>{code(false)}</If>
      <If when={foldable()}>
        <Button onPress={() => open.set(!open())} accessibilityLabel={open() ? "Show fewer lines" : `Show all ${lines()} lines`} class={`min-h-8 flex-row items-center justify-center gap-1 hover:bg-accent ${FOCUS_RING}`}>
          <Text class="text-xs font-medium text-muted-foreground">{open() ? "Show less" : `Show all ${lines()} lines`}</Text>
          <If when={!open()}>
            <Icon name="chevron-down" size={14} tone="muted-foreground" />
          </If>
        </Button>
      </If>
    </View>
  );
}

/** A small text tool of a block's header: 24 pt high, quiet, named for screen readers by what it does. */
function Tool(props: { label: string; text: string; onPress: () => void; selected?: boolean; icon?: "copy" | "check" }) {
  return (
    <Tipped label={props.label}>
      <Button
        onPress={props.onPress}
        accessibilityLabel={props.label}
        selected={props.selected}
        class={`min-h-7 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent selected:bg-accent ${FOCUS_RING}`}
      >
        <If when={props.icon}>{(name) => <Icon name={name()} size={14} tone="muted-foreground" />}</If>
        <Text class="text-xs text-muted-foreground">{props.text}</Text>
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
