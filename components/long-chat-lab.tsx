import { effect, host, keymap, mount, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import type { ImageView, SessionItem, SessionView, ToolItem } from "herdr-desktop/native";

import type { RowContext } from "#components/session-item";
import { SessionTranscript, type TranscriptHandle } from "#components/session-transcript";
import { PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { startHerdr } from "#lib/herdr";
import { warmCode } from "#lib/highlight";
import { counts, countWork, resetCounts } from "#lib/perf-counts";
import { createSessionModel, type SessionPort } from "#lib/session";
import { pictureSource } from "#lib/session-pictures";
import { loadSettings } from "#lib/settings";

/**
 * A long conversation for measuring the chat's scroll (`components/long-chat.test.tsx`, `docs/PERFORMANCE.md`): `turns`
 * turns (default 420) of short questions, long answers with lists, links, tables and fences of 10 to 80 lines in five
 * languages and diffs, runs of 6 to 20 calls (every third run open, so its box of calls is drawn), failures, pushes and
 * pictures. Synthetic and deterministic. `SessionTranscript` is mounted alone, over a port of this file, with the work
 * counters on (`lib/perf-counts.ts`); the line `Counts: {...}` says what the rows did, `Reset counts` starts again.
 * Not part of the app.
 */
const params = host.params as { turns?: number };
startHerdr("", "empty");
void loadSettings();
warmCode();
countWork(true);

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAQElEQVR42u3MoREAMAgEQQpLEakETTlfTvRXFM95FDOrN069JkFgiI1GIzUJAsNGs1E1CQLDRrPRbRIEho0Gow+BQHjuK4CvmgAAAABJRU5ErkJggg==";
pictureSource.fetch = async () => PNG;

let next = 1;
const base = (kind: string): SessionItem => ({ id: next++, rev: 1, kind, images: [], parts: [] }) as SessionItem;
const say = (role: "user" | "agent" | "thought", text: string, images: ImageView[] = []): SessionItem => ({
  ...base("message"),
  role,
  text,
  images,
});
const call = (title: string, over: Partial<ToolItem>): SessionItem => ({
  ...base("tool"),
  tool: {
    id: `t${next}`,
    title,
    toolKind: "execute",
    status: "completed",
    head: [],
    tail: [],
    omitted: 0,
    diffs: [],
    locations: [],
    parts: [],
    terminal: false,
    ...over,
  },
});

/** A small deterministic generator, so every run draws the same conversation. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rand = rng(42);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const WORDS =
  "the client retries each request until the server answers or the budget runs out and the ledger records every attempt with its cause so a failure later can be traced back to the call that made it".split(
    " ",
  );
const sentence = () => {
  const n = between(8, 22);
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0]!.charAt(0).toUpperCase() + w[0]!.slice(1);
  if (rand() < 0.3) w[between(1, n - 1)] = "`retry_budget`";
  if (rand() < 0.15) w[between(1, n - 1)] = "[the docs](https://example.com/retry)";
  if (rand() < 0.15) w[between(1, n - 1)] = "**never**";
  return `${w.join(" ")}.`;
};
const paragraph = () => Array.from({ length: between(2, 5) }, sentence).join(" ");

const LANGS = ["ts", "rust", "python", "go", "sh"] as const;
function fence(lang: (typeof LANGS)[number], lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => {
    switch (lang) {
      case "ts":
        return `  const step${i} = await client.send({ id: ${i}, attempts: ${i % 5} }); // ${pick(WORDS)}`;
      case "rust":
        return `    let step_${i} = ledger.record(${i}, "entry-${i}", ${(i * 7) % 100})?;`;
      case "python":
        return `    step_${i} = transport.call(req, timeout=${(i % 9) + 1}.5)  # ${pick(WORDS)}`;
      case "go":
        return `\tstep${i}, err := client.Do(ctx, req${i % 3}) // ${pick(WORDS)}`;
      default:
        return `pnpm test --filter @acme/case-${i} --reporter=verbose`;
    }
  });
  return [`\`\`\`${lang}`, ...body, "```"].join("\n");
}
function diff(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) =>
    i % 4 === 0
      ? `@@ -${i},3 +${i},4 @@`
      : i % 3 === 0
        ? `-  old line ${i}`
        : i % 3 === 1
          ? `+  new line ${i}`
          : `   kept ${i}`,
  );
  return ["```diff", "--- a/src/client.ts", "+++ b/src/client.ts", ...body, "```"].join("\n");
}

/** One answer: prose, a list, sometimes a table, and 0 to 2 fences or a diff. */
function answer(n: number): string {
  const parts = [`Answer ${n}. ${paragraph()}`];
  const r = rand();
  if (r < 0.55) parts.push(fence(pick(LANGS), between(10, 80)));
  if (r < 0.2) parts.push(paragraph(), fence(pick(LANGS), between(10, 40)));
  if (r > 0.75) parts.push(diff(between(10, 50)));
  parts.push(
    Array.from({ length: between(2, 6) }, (_, i) => `${i + 1}. ${sentence()}`).join("\n"),
    rand() < 0.25 ? "| Check | Result |\n|---|---|\n| unit tests | 42 passed |\n| types | clean |" : paragraph(),
  );
  return parts.join("\n\n");
}

const picture = (n: number): ImageView => ({ key: `p-${n}`, mime: "image/png", bytes: 164, source: `keeper:${n}:0` });

function conversation(turns: number): SessionItem[] {
  const items: SessionItem[] = [];
  for (let t = 1; t <= turns; t++) {
    items.push(say("user", `Question ${t}: ${sentence()}`, t % 23 === 0 ? [picture(t)] : []));
    if (t % 4 !== 1) {
      const calls = between(6, 20);
      for (let c = 0; c < calls; c++) {
        const k = c % 4;
        items.push(
          k === 0
            ? call(`Read src/mod-${c}.ts`, { toolKind: "read", subject: `/src/mod-${c}.ts` })
            : k === 1
              ? call(`Run: pnpm test ${c}`, {
                  subject: `pnpm test ${c}`,
                  status: t % 7 === 0 && c === 1 ? "failed" : "completed",
                  tail: ["PASS src/a.test.ts", "1 failed, 39 passed"],
                })
              : k === 2
                ? call(`Edit src/mod-${c}.ts`, {
                    toolKind: "edit",
                    subject: `/src/mod-${c}.ts`,
                    diffs: [{ path: `/src/mod-${c}.ts`, old: "a\nb\n", new: "a\nc\nd\n", added: 2, removed: 1 }],
                  })
                : call(`Search retry`, { toolKind: "search", subject: "retry" }),
        );
        if (c === 3 && t % 5 === 0) items.push(say("agent", `Narration ${t}: ${sentence()}`));
      }
      if (t % 11 === 0)
        items.push(
          call("Run: git push", {
            subject: "git push origin main",
            effect: { kind: "push", text: "Pushed to origin/main" },
          }),
        );
    }
    items.push(say("agent", answer(t)));
  }
  return items;
}

const items = conversation(params.turns ?? 420);
const view: SessionView = {
  revision: 1,
  phase: "idle",
  connectionLost: false,
  agent: "claude",
  cwd: "/src",
  title: "A long conversation",
  itemCount: items.length,
  droppedItems: 0,
  waiting: [],
  queue: [],
  commands: [],
  options: [],
  plan: [],
  running: false,
  acceptsPictures: true,
  acp: {
    canResume: false,
    canList: false,
    canClose: false,
    canLogout: false,
    acceptsAudio: false,
    acceptsEmbedded: false,
    auth: [],
  },
} as SessionView;

const nothing = async () => ({ kind: "done" as const, message: "" });
const port: SessionPort = {
  revision: signal(0),
  view: () => view,
  items: (start, count) => items.slice(start, start + count),
  itemIds: () => items.map((i) => i.id),
  send: nothing,
  unqueue: async () => null,
  releaseQueue: nothing,
  cancel: nothing,
  reconnect: async () => undefined,
  authenticate: nothing,
  reopen: nothing,
  loadEarlier: async () => false,
};

function Lab() {
  const model = createSessionModel(port, { answered: () => {}, streamed: () => {}, arrived: () => {} });
  const ctx: RowContext = { machine: "local", id: "long", cwd: "/src", model };
  // Every third run of calls is open, so its box of 6 to 20 calls is drawn as a person who opened it sees it.
  let opened = false;
  effect(() => {
    const rows = model.rows();
    if (opened || rows.length === 0) return;
    opened = true;
    untracked(() => rows.filter((r) => r.kind === "work").forEach((r, i) => i % 3 === 0 && model.toggle(r)));
  });
  const shown = signal("");
  let handle: TranscriptHandle | undefined;
  const read = () => shown.set(JSON.stringify({ ...counts(), ...handle?.where() }));
  // Keys as well as buttons: a press into the header is not always delivered on the macOS host.
  keymap.bind(
    {
      "ctrl+alt+r": read,
      "ctrl+alt+0": () => {
        resetCounts();
        shown.set("");
      },
    },
    { when: "always" },
  );
  const atEnd = signal(true);
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-row items-center gap-3 border-b border-border px-3 py-1">
          <Text class="text-xs text-muted-foreground">{`Rows: ${model.rows().length}`}</Text>
          <Button accessibilityLabel="Read counts" onPress={read}>
            <Text class="text-xs text-foreground">Read counts</Text>
          </Button>
          <Button
            accessibilityLabel="Reset counts"
            onPress={() => {
              resetCounts();
              shown.set("");
            }}
          >
            <Text class="text-xs text-foreground">Reset counts</Text>
          </Button>
          <Text class="text-xs text-muted-foreground">{`At end: ${atEnd() ? "yes" : "no"}`}</Text>
        </View>
        <Text class="px-3 text-xs text-muted-foreground">{`Counts: ${shown()}`}</Text>
        <SessionTranscript
          ctx={ctx}
          panel="long-chat-lab"
          active
          atEnd={atEnd}
          unseen={signal(0)}
          waiting={() => false}
          opening={() => false}
          onHandle={(h) => {
            handle = h;
          }}
        />
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
