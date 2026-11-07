import { Lines } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, keymap, List, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import type { LinesView } from "herdr-desktop/native";
import type { InputRef, ListRef } from "nsh/types";

import { Btn, Empty, IconButton, INPUT_CLASS, NUM, Spinner } from "#kit";

/** Height of one line, and how many lines one list row holds: rows have an exact height, so a line's place is arithmetic. */
const LINE_H = 20;
const ROW_LINES = 50;

/** Rows kept in memory beyond the ones on screen. */
const KEEP_ROWS = 24;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const grouped = (n: number): string => n.toLocaleString("en-US");

/**
 * The find bar of a big file (`mod+f`): Enter goes to the next line that holds the text, Shift+Enter to the one before,
 * both wrapping once round the file; the search streams through the file in 1 MB ranges on a thread, and a newer one
 * stops the one running. Case is ignored for ASCII letters.
 */
function LargeFind(props: {
  file: number;
  /** The line the view is at: the search goes on from there. */
  from: () => number;
  /** The count is still running: a match past what it reached is not found yet. */
  counting: () => boolean;
  onFound: (line: number) => void;
  onClose: () => void;
}) {
  const query = signal("");
  const status = signal("");
  const busy = signal(false);
  const focused = signal(false);
  let field: InputRef | undefined;
  let latest = 0;

  const search = async (forward: boolean, fromLine: number | undefined) => {
    const text = query();
    if (text === "") {
      status.set("");
      return;
    }
    const mine = ++latest;
    busy.set(true);
    try {
      const hit = await Lines.find(props.file, text, fromLine ?? null, forward);
      if (mine !== latest) return;
      if (hit === undefined || hit === null) {
        status.set(props.counting() ? "No match yet: still counting lines" : "No matches");
        announce(status());
        return;
      }
      status.set(`Line ${grouped(hit + 1)}`);
      announce(status());
      props.onFound(hit);
    } catch (e) {
      if (mine === latest) status.set(reason(e));
    } finally {
      if (mine === latest) busy.set(false);
    }
  };
  // Typing finds from the line on screen (that line included); Enter and Shift+Enter step from the match.
  const typed = () => void search(true, props.from() > 0 ? props.from() - 1 : undefined);
  const step = (forward: boolean) => void search(forward, props.from());

  effect(() => {
    if (!focused()) return;
    return keymap.bind({ "shift+enter": () => step(false), escape: () => props.onClose() }, { when: "always" });
  });

  return (
    <View class="flex-row items-center gap-2 border-b border-border bg-card px-3 py-2">
      <Input
        ref={(node: InputRef) => {
          field = node;
        }}
        value={query()}
        onChange={({ value }) => {
          query.set(value);
          typed();
        }}
        placeholder="Find in the file"
        accessibilityLabel="Text to find in the file"
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        submitBehavior="submit"
        onSubmit={() => step(true)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        class={`${INPUT_CLASS} w-64`}
      />
      <Text class="min-w-24 text-xs text-muted-foreground" accessibilityLabel={status() || undefined}>
        {busy() ? "Searching…" : status()}
      </Text>
      <Btn
        small
        label="Previous"
        name="Previous match"
        onPress={() => {
          step(false);
          field?.focus();
        }}
      />
      <Btn
        small
        label="Next"
        name="Next match"
        onPress={() => {
          step(true);
          field?.focus();
        }}
      />
      <View class="flex-1" />
      <IconButton icon="x" label="Close find" onPress={props.onClose} />
    </View>
  );
}

/**
 * A text file too big to hold, read a page at a time: the lines scroll in a virtual list whose rows load from Rust when
 * they come into view (a few kilobytes each, from the nearest checkpoint of an index that one pass over the file builds
 * in the background, so the first page shows at once and the line count grows as it goes). `Ctrl+F` finds through the
 * whole file, `Go to line` jumps. Read only; lines longer than 4000 characters are cut. Only a few rows are kept in memory.
 */
export function LargeText(props: {
  machine: string;
  path: string;
  name: string;
  height: number;
  finding: boolean;
  onCloseFind: () => void;
}) {
  const info = signal<LinesView | null>(null);
  const failure = signal<string | null>(null);
  const version = signal(0);
  const current = signal(0);
  const marked = signal<number | null>(null);
  const jump = signal("");
  let list: ListRef | undefined;
  const cache = new Map<number, string[]>();
  const pending = new Set<number>();
  let file: number | null = null;
  let closed = false;

  const lines = () => info()?.lines ?? 0;
  const rows = computed(() => Array.from({ length: Math.ceil(lines() / ROW_LINES) }, (_, i) => i));
  const gutter = () => String(Math.max(lines(), 1)).length * 8 + 28;
  const counting = () => info() !== null && !info()!.done;

  // Opens the file, then follows the count while it runs.
  Lines.open(props.machine, props.path).then(
    (opened) => {
      if (closed) {
        Lines.close(opened.id);
        return;
      }
      file = opened.id;
      info.set(opened);
    },
    (e) => failure.set(reason(e)),
  );
  const poll = setInterval(() => {
    if (file === null || !counting()) return;
    try {
      info.set(Lines.state(file));
    } catch (e) {
      failure.set(reason(e));
    }
  }, 300);
  cleanup(() => {
    closed = true;
    clearInterval(poll);
    if (file !== null) Lines.close(file);
  });

  // A row is read when it comes into view; a row only part counted is read again as the count grows.
  const request = (row: number) => {
    if (file === null || cache.has(row) || pending.has(row)) return;
    const id = file;
    pending.add(row);
    Lines.read(id, row * ROW_LINES, ROW_LINES).then(
      (got) => {
        pending.delete(row);
        if (closed) return;
        const whole = got.length === ROW_LINES || (info()?.done ?? false);
        if (!whole) {
          version.update((v) => v + 1);
          return;
        }
        cache.set(row, got);
        while (cache.size > KEEP_ROWS) cache.delete(cache.keys().next().value as number);
        version.update((v) => v + 1);
      },
      (e) => {
        pending.delete(row);
        failure.set(reason(e));
      },
    );
  };

  const show = (line: number) => {
    const at = Math.max(0, Math.min(line, Math.max(0, lines() - 1)));
    marked.set(at);
    current.set(at);
    list?.scrollToOffset({ offset: Math.max(0, at * LINE_H - props.height / 2), animated: false });
  };

  const goTo = () => {
    const n = Number(jump().replace(/[,\s]/g, ""));
    if (!Number.isFinite(n) || n < 1) return;
    show(Math.floor(n) - 1);
    announce(`Line ${grouped(Math.floor(n))}`);
  };

  const status = () => {
    const i = info();
    if (!i) return "";
    return i.done
      ? `${grouped(i.lines)} lines`
      : `${grouped(i.lines)} lines so far · counting, ${Math.round(i.scanned * 100)}%`;
  };

  // The line of the top of the view, for the search to go on from.
  const viewTop = signal(0);
  effect(() => {
    version();
  });

  return (
    <View class="gap-2">
      <If when={props.finding && file !== null ? info() : null}>
        {() => (
          <LargeFind
            file={file ?? 0}
            from={() => marked() ?? viewTop()}
            counting={counting}
            onFound={show}
            onClose={props.onCloseFind}
          />
        )}
      </If>
      <If
        when={failure()}
        else={
          <If
            when={info()}
            else={
              <View style={{ height: props.height }} class="items-center justify-center">
                <Spinner />
              </View>
            }
          >
            <View
              role="group"
              accessibilityLabel={`${props.name}, read only`}
              style={{ height: props.height }}
              class="overflow-hidden rounded-md border border-border bg-card"
            >
              <List
                ref={(node: ListRef) => {
                  list = node;
                }}
                class="flex-1"
                each={rows()}
                estimatedItemSize={ROW_LINES * LINE_H}
                keyExtractor={(row) => String(row)}
                onScroll={({ offset }) => viewTop.set(Math.floor(offset.y / LINE_H))}
              >
                {(row) => {
                  effect(() => {
                    const r = row();
                    version();
                    untracked(() => request(r));
                  });
                  const text = () => {
                    version();
                    return cache.get(row()) ?? [];
                  };
                  const first = () => row() * ROW_LINES;
                  const count = () => Math.min(ROW_LINES, lines() - first());
                  return (
                    <View style={{ height: Math.max(1, count()) * LINE_H }} class="flex-row">
                      <View style={{ width: gutter() }} class="items-end pr-3">
                        <Each of={Array.from({ length: count() }, (_, i) => first() + i)}>
                          {(n) => (
                            <Text
                              style={[NUM, { height: LINE_H, userSelect: "none" }]}
                              class="font-mono text-xs leading-5 text-muted-foreground"
                            >
                              {String(n() + 1)}
                            </Text>
                          )}
                        </Each>
                      </View>
                      <View class="min-w-0 flex-1 overflow-hidden">
                        <If when={marked() !== null && marked()! >= first() && marked()! < first() + ROW_LINES}>
                          <View
                            class="absolute inset-x-0 bg-accent"
                            style={{ top: (marked()! - first()) * LINE_H, height: LINE_H }}
                          />
                        </If>
                        <Each of={Array.from({ length: count() }, (_, i) => i)}>
                          {(i) => (
                            <Text
                              style={{ height: LINE_H, userSelect: "text", textOverflow: "clip", numberOfLines: 1 }}
                              class="font-mono text-xs leading-5 text-foreground"
                            >
                              {text()[i()] ?? ""}
                            </Text>
                          )}
                        </Each>
                      </View>
                    </View>
                  );
                }}
              </List>
            </View>
          </If>
        }
      >
        {(message) => <Empty icon="alert" title="This file cannot be read" hint={message()} />}
      </If>
      <View class="flex-row flex-wrap items-center gap-3">
        <Text style={NUM} class="text-xs text-muted-foreground">
          {status()}
        </Text>
        <View class="flex-1" />
        <Input
          value={jump()}
          onChange={({ value }) => jump.set(value)}
          placeholder="Go to line"
          accessibilityLabel="Go to line"
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          submitBehavior="submit"
          onSubmit={goTo}
          class={`${INPUT_CLASS} w-32`}
        />
      </View>
    </View>
  );
}
