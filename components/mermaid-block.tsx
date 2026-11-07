import { colorScheme, computed, signal, Text, token, View, WebView } from "nsh";
import { Editor } from "nsh/base";
import { Diagrams } from "herdr-desktop/native";
import { type DiagramColors, type DiagramResult, diagramPage, diagramTitle, parseDiagramResult } from "#lib/mermaid";
import { Btn, Modal } from "#kit";

/** The most height a diagram takes in a document before it scrolls inside its frame; `Open diagram` shows it larger. */
const INLINE_MAX = 360;
const OPEN_MAX = 480;

type Origin = { url: string; error?: undefined } | { url?: undefined; error: string };
let served: Origin | undefined;

/** The address the bundled script is served from, or why it cannot be (then the source is all there is). Asked once. */
function origin(): Origin {
  if (served) return served;
  try {
    served = { url: Diagrams.origin() };
  } catch (e) {
    served = { error: e instanceof Error ? e.message : String(e) };
  }
  return served;
}

/** The theme's colours as CSS the page can use (`token()` follows the theme and the appearance). */
function colors(): DiagramColors {
  return { background: token("card"), text: token("card-foreground"), line: token("muted-foreground"), fill: token("muted"), border: token("border") };
}

/** The drawing: a web view that loads the page of `diagramPage` and is as tall as the diagram, up to `max`. */
function Drawing(props: { code: string; max: number; onResult: (result: DiagramResult | null) => void }) {
  const where = origin();
  const height = signal(120);
  const capped = signal(false);
  const title = diagramTitle(props.code);
  const page = computed(() => (where.url ? diagramPage({ origin: where.url, code: props.code, title, dark: colorScheme() === "dark", colors: colors() }) : ""));
  return (
    <If when={where.url}>
      <WebView
        html={page()}
        baseUrl={where.url}
        accessibilityLabel={title}
        javaScriptEnabled
        scrollable={capped()}
        onMessage={({ data }) => {
          const result = parseDiagramResult(data);
          if (result?.ok) {
            height.set(Math.min(props.max, Math.max(60, result.h)));
            capped.set(result.h > props.max);
          }
          props.onResult(result);
        }}
        class="w-full rounded-md"
        style={{ height: height() }}
      />
    </If>
  );
}

/** The source as the diagram's text alternative: read only, highlighted as text, copyable. */
function Source(props: { code: string; title: string }) {
  return <Editor readOnly language="text" value={props.code} lineNumbers={false} folding={false} minRows={1} maxRows={14} fontSize={12} accessibilityLabel={`${props.title}, source`} class="w-full rounded-md border border-border bg-card" />;
}

/**
 * A ```` ```mermaid ```` block as a diagram, drawn by the bundled mermaid in a web view with no network. It is named
 * `Diagram: <title>` (the web view carries that name and so does the label above it), the source is one press away as
 * its text alternative (`Show source`), and `Open diagram` shows it larger in a dialog. A source mermaid cannot draw
 * stays what it was, a block of text, with one line saying why: a wrong diagram never replaces readable text.
 */
export function MermaidBlock(props: { code: string }) {
  const title = diagramTitle(props.code);
  const failure = signal<string | null>(null);
  const source = signal(false);
  const opened = signal(false);
  const why = () => failure() ?? origin().error ?? null;
  return (
    <View class="my-2 gap-2 rounded-md border border-border bg-card p-3">
      <View class="flex-row items-center gap-2">
        <Text role="header" class="min-w-0 flex-1 text-sm font-medium text-foreground">
          {title}
        </Text>
        <If when={!why()}>
          <Btn small label="Open diagram" onPress={() => opened.set(true)} />
        </If>
        <If when={!why()}>
          <Btn small label={source() ? "Hide source" : "Show source"} name={source() ? "Hide the diagram's source" : "Show the diagram's source"} onPress={() => source.update((s) => !s)} />
        </If>
      </View>
      <If when={why()}>
        {(message) => (
          <Text role="alert" class="text-xs text-muted-foreground">{`Couldn't draw this diagram · ${message()} · showing the source`}</Text>
        )}
      </If>
      <If when={!why()}>
        <Drawing code={props.code} max={INLINE_MAX} onResult={(r) => r && !r.ok && failure.set(r.message)} />
      </If>
      <If when={why() || source()}>
        <Source code={props.code} title={title} />
      </If>
      <Modal open={opened()} huge onClose={() => opened.set(false)} title={title} actions={<Btn label="Close" hint="Esc" onPress={() => opened.set(false)} />}>
        <If when={opened()}>
          <Drawing code={props.code} max={OPEN_MAX} onResult={() => undefined} />
        </If>
      </Modal>
    </View>
  );
}
