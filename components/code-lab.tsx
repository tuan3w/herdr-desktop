import { effect, host, mount, signal, Text, View } from "nsh";
import { DiffView, Editor, TextView } from "nsh/base";
import { Code } from "herdr-desktop/native";
import { CodeBlock, InlineCode } from "#components/code-block";
import { DiffBlock } from "#components/diff-block";
import { codeLineNumbers, codeWrap } from "#lib/highlight";
import { PopupRoot, ThemeRoot } from "#kit";

/**
 * The entry of the code labs and of the `code-*` screenshots: every synthetic sample, a fence being written, a diff, a
 * block of 3,000 lines, and the same block drawn by nsh's own `TextView`, `Editor` and `DiffView` for comparison.
 * `host.params.part` picks one: `languages` (a page of blocks, `from`/`count` choose which), `one` (`lang`, opened, with
 * line numbers), `stream` (`lang`, a fence that grows), `diff` (`layout`), `long` (`lines`), `compare` (`lang`), `inline`.
 * Not part of the app. Fonts are registered by the entry above it (`code-lab-app.tsx`: assets must live under the entry's folder).
 */
const part = typeof host.params.part === "string" ? host.params.part : "languages";
const wanted = typeof host.params.lang === "string" ? host.params.lang : "ts";
const samples = Code.samples();
const sample = (fence: string) => samples.find((s) => s.fence === fence) ?? samples[0];

/** A before and after that exercise a change inside a line, an added block, a removed line, a far-off second change. */
const OLD = `import { readFile } from "node:fs/promises";

const TIMEOUT_MS = 2_500;

export async function load(key: string): Promise<string[]> {
  const text = await readFile(key + ".json", "utf8");
  const parsed = JSON.parse(text) as string[];
  console.log("loaded", parsed.length);
  return parsed;
}

export function total(rows: number[]): number {
  let sum = 0;
  for (const r of rows) {
    sum += r;
  }
  return sum;
}

// unchanged filler so that a fold shows between the two changes
export const a = 1;
export const b = 2;
export const c = 3;
export const d = 4;
export const e = 5;
export const f = 6;
export const g = 7;
export const h = 8;

export function last(rows: number[]): number | undefined {
  return rows[rows.length - 1];
}
`;
const NEW = `import { readFile } from "node:fs/promises";

const TIMEOUT_MS = 5_000;

export async function load(key: string, signal?: AbortSignal): Promise<string[]> {
  const text = await readFile(\`\${key}.json\`, { encoding: "utf8", signal });
  const parsed = JSON.parse(text) as string[];
  return parsed;
}

export function total(rows: number[]): number {
  return rows.reduce((sum, r) => sum + r, 0);
}

// unchanged filler so that a fold shows between the two changes
export const a = 1;
export const b = 2;
export const c = 3;
export const d = 4;
export const e = 5;
export const f = 6;
export const g = 7;
export const h = 8;

export function last(rows: number[]): number | undefined {
  return rows.at(-1);
}
`;

const bigText = () => {
  const base = sample("rust").text;
  let out = "";
  while (out.split("\n").length < Number(host.params.lines ?? 3000)) out += base;
  return out;
};

function Stream(props: { fence: string }) {
  const full = sample(props.fence).text;
  const cut = signal(0);
  const step = typeof host.params.chunk === "number" ? host.params.chunk : 24;
  effect(() => {
    const id = setInterval(() => cut.update((n) => Math.min(full.length, n + step)), 40);
    return () => clearInterval(id);
  });
  return <CodeBlock code={full.slice(0, cut())} language={props.fence} streaming={cut() < full.length} />;
}

function Compare(props: { fence: string }) {
  const s = sample(props.fence);
  const md = `\`\`\`${s.fence}\n${s.text}\`\`\``;
  return (
    <View class="flex-1 flex-row gap-3">
      <View class="flex-1 gap-1">
        <Text class="text-xs text-muted-foreground">nsh TextView</Text>
        <View class="flex-1 overflow-hidden"><TextView markdown={md} /></View>
      </View>
      <View class="flex-1 gap-1">
        <Text class="text-xs text-muted-foreground">nsh Editor</Text>
        <Editor readOnly language={s.path} value={s.text} lineNumbers folding={false} fontSize={13} accessibilityLabel="Editor" class="flex-1 rounded-md border border-border bg-card" />
      </View>
      <View class="flex-1 gap-1">
        <Text class="text-xs text-muted-foreground">herdr CodeBlock</Text>
        <CodeBlock code={s.text} language={s.fence} path={s.path} open collapsedLines={0} />
      </View>
    </View>
  );
}

function Lab() {
  if (host.params.wrap === true) codeWrap.set(true);
  if (host.params.numbers === true) codeLineNumbers.set(true);
  const from = Number(host.params.from ?? 0);
  const count = Number(host.params.count ?? 4);
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1 gap-3 overflow-hidden p-4">
          <If when={part === "languages"}>
            <Each of={samples.slice(from, from + count)} key={(s) => s.fence}>
              {(s) => <CodeBlock code={s().text} language={s().fence} path={s().path} collapsedLines={Number(host.params.fold ?? 8)} />}
            </Each>
          </If>
          <If when={part === "one"}>
            <CodeBlock code={sample(wanted).text} language={sample(wanted).fence} path={sample(wanted).path} open collapsedLines={0} maxHeight={720} />
          </If>
          <If when={part === "stream"}>
            <Stream fence={wanted} />
          </If>
          <If when={part === "diff"}>
            <DiffBlock path="src/reader.ts" oldText={OLD} newText={NEW} split={host.params.layout === "split"} />
          </If>
          <If when={part === "host-diff"}>
            <DiffView oldValue={OLD} newValue={NEW} language="ts" layout="unified" class="flex-1" />
          </If>
          <If when={part === "patch"}>
            <DiffBlock patch={sample("diff").text} path="src/ledger.rs" />
          </If>
          <If when={part === "long"}>
            <CodeBlock code={bigText()} language="rust" open collapsedLines={0} />
          </If>
          <If when={part === "compare"}>
            <Compare fence={wanted} />
          </If>
          <If when={part === "inline"}>
            <View class="gap-2">
              <Text class="text-sm text-foreground">Run <InlineCode>pnpm test --watch</InlineCode> and look at <InlineCode>src/auth.ts:42</InlineCode>.</Text>
            </View>
          </If>
        </View>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
