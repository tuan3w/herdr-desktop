import { Sessions } from "herdr-desktop/native";
import { cleanup, computed, effect, signal, untracked } from "nsh";

import type { ActionResult, PictureInput, SessionItem, SessionView, UnqueuedView } from "herdr-desktop/native";
import type { Accessor } from "nsh";

import { revision } from "#lib/herdr";
import { buildRows, type Row, unitStart } from "#lib/session-rows";

/**
 * One chat's data for a screen. The Rust side holds the conversation; this file pulls it the way `docs/ARCHITECTURE.md`
 * says every screen does: told "revision N", it asks `view()` (cheap, no rows) and fetches only the rows it has not
 * got. The rows are cached by id, so a 5,000-row transcript is read once, and a streamed word costs the last few rows
 * (`TAIL`), not the conversation. `SessionPort` is the seam: `sessionPort` is the real module, a test passes its own.
 */

/**
 * `read()` that never goes back to null: while a screen is being taken down (the session was closed under it, a pane
 * went away) its accessors are still read once more, and a view that vanished must not throw there. It keeps the last
 * value it saw.
 */
export function latest<T>(read: () => T | null | undefined): () => T {
  let last: T | undefined;
  return () => {
    const now = read();
    if (now !== null && now !== undefined) last = now;
    return last!;
  };
}

/** What the chat reads and does. The real one is `sessionPort`. */
export interface SessionPort {
  /** Moves whenever anything of any session may have changed; the model pulls `view()` after it. */
  revision: Accessor<number>;
  view(): SessionView | null;
  items(start: number, count: number): SessionItem[];
  itemIds(): number[];
  send(text: string, files: string[], pictures: PictureInput[]): Promise<ActionResult>;
  unqueue(queued: number): Promise<UnqueuedView | null>;
  releaseQueue(): Promise<ActionResult>;
  cancel(): Promise<ActionResult>;
  /** Opens the connection again after `connectionLost`. */
  reconnect(): Promise<void>;
  /** Signs in with a method the agent handles itself (`SessionView.acp.auth`). */
  authenticate(methodId: string): Promise<ActionResult>;
  /** Opens the session the agent refused for want of a sign-in once more, after the person signed in in a terminal. */
  reopen(): Promise<ActionResult>;
}

/** The `Sessions` module as one session's port. */
export function sessionPort(machine: string, id: string): SessionPort {
  return {
    revision,
    view: () => Sessions.view(machine, id),
    items: (start, count) => Sessions.items(machine, id, start, count),
    itemIds: () => Sessions.itemIds(machine, id),
    send: (text, files, pictures) => Sessions.send(machine, id, text, files, pictures),
    unqueue: (queued) => Sessions.unqueue(machine, id, queued),
    releaseQueue: () => Sessions.releaseQueue(machine, id),
    cancel: () => Sessions.cancel(machine, id),
    reconnect: async () => {
      await Sessions.attach(machine, id);
    },
    authenticate: (methodId) => Sessions.authenticate(machine, id, methodId),
    reopen: () => Sessions.reopen(machine, id),
  };
}

/** Tells the screen what happened in a way a person is told: out loud or by a count, never by the rows themselves. */
export interface SessionHooks {
  /** A turn ended and the agent said something: the start of its last message. */
  answered(text: string): void;
  /** The message being written grew by `text`. */
  streamed(text: string): void;
  /** `messages` new agent messages arrived. */
  arrived(messages: number): void;
}

/** What `working` says about a running turn. */
export interface Working {
  /** Whole seconds the turn has run; `null` when the agent did not say when it began, or this window has not yet seen a row arrive to tell its clock by. */
  seconds: number | null;
  /** Whole minutes without any event from the agent, once it is a minute or more: the honest stuck signal. */
  quietMinutes: number | null;
}

/** One chat as rows. */
export interface SessionModel {
  /** The session as it stands; `null` before it is attached. The same object until its `revision` moves. */
  view: Accessor<SessionView | null>;
  rows: Accessor<readonly Row[]>;
  working: Accessor<Working | null>;
  /** Opens a folded row or folds an open one; the choice outlives scrolling the row away. */
  toggle(row: Row): void;
  /** Flips a choice that is not a row's own fold, by its key (`moreKey`): `now` is what it is showing. */
  choose(key: string, now: boolean): void;
  /** What the person chose for `key` (`true` open, `false` closed), `undefined` when they never did. Reactive. */
  chosen(key: string): boolean | undefined;
}

/** Rows read again on every revision: enough to follow a stream and a handful of parallel calls, however long the chat. */
const TAIL = 24;
/** Unfinished calls older than the tail that are read again; more would be stale ones that never report. */
const OPEN_CALLS = 8;
/** Seconds without an event after which `Quiet for` appears. */
const QUIET_AFTER = 60;

/** Builds the model for `port` in the calling component's scope (it listens and stops with it). */
export function createSessionModel(port: SessionPort, hooks: SessionHooks): SessionModel {
  const entries = new Map<number, SessionItem>();
  const unfinished = new Set<number>();
  let list: SessionItem[] = [];
  let ids: number[] = [];
  let dropped = -1;
  let loaded = false;
  let lastRevision = -1;
  let lastView: SessionView | null = null;
  let lastEventAt = Date.now();
  let wasRunning = false;
  /** Wall clock minus the session's own clock (`SessionItem.startedMs`): learned from what arrives live, `null` until then. */
  let offset: number | null = null;
  let streamedId = -1;
  let streamedLength = 0;
  /** Agent messages `store` saw arrive since the hook last heard. */
  let arrived = 0;
  /** Lowest index whose row changed since the committed rows were built. */
  let changedFrom = Infinity;

  const viewSignal = signal<SessionView | null>(null);
  const version = signal(0);
  const clock = signal(Date.now());
  const choices = signal<ReadonlyMap<string, boolean>>(new Map());

  const store = (item: SessionItem, index: number, now: number): void => {
    const old = entries.get(item.id);
    if (old && old.rev === item.rev) return;
    if (!old && loaded) {
      // A row that arrives live was started a moment ago: that pairs the session's clock with ours.
      if (item.startedMs != null) offset = now - item.startedMs;
      if (item.kind === "message" && item.role === "agent") arrived += 1;
    }
    entries.set(item.id, item);
    if (list[index]?.id === item.id) list[index] = item;
    if (item.tool && (item.tool.status === "pending" || item.tool.status === "inProgress")) unfinished.add(item.id);
    else unfinished.delete(item.id);
    changedFrom = Math.min(changedFrom, index);
  };

  const fetch = (start: number, count: number, now: number): void => {
    if (count <= 0) return;
    const got = port.items(start, count);
    got.forEach((item, k) => store(item, start + k, now));
  };

  const pull = (v: SessionView): void => {
    const now = Date.now();
    let reshaped = false;
    if (v.itemCount !== ids.length || v.droppedItems !== dropped) {
      const fresh = port.itemIds();
      if (v.droppedItems !== dropped) {
        // Rows dropped from the start shift every index: forget what left, and read everything from the top again.
        const keep = new Set(fresh);
        for (const id of entries.keys()) if (!keep.has(id)) entries.delete(id);
        changedFrom = 0;
      }
      dropped = v.droppedItems;
      ids = fresh;
      reshaped = true;
    }
    const first = ids.findIndex((id) => !entries.has(id));
    if (first >= 0) fetch(first, ids.length - first, now);
    const tailAt = Math.max(0, ids.length - TAIL);
    if (first < 0 || first > tailAt) fetch(tailAt, ids.length - tailAt, now);
    for (const id of [...unfinished].slice(-OPEN_CALLS)) {
      const at = ids.indexOf(id);
      if (at >= 0 && at < tailAt) fetch(at, 1, now);
    }
    // `store` mends `list` in place for a row that changed; a row that arrived or left makes it again from the ids.
    if (reshaped || list.length !== ids.length) {
      list = ids.map((id) => entries.get(id)).filter((i): i is SessionItem => i !== undefined);
    }
    if (arrived > 0) hooks.arrived(arrived);
    arrived = 0;

    const last = list[list.length - 1];
    if (loaded && v.running && last?.kind === "message" && last.role === "agent") {
      const text = last.text ?? "";
      const from = last.id === streamedId ? streamedLength : 0;
      if (text.length > from) hooks.streamed(text.slice(from));
      streamedId = last.id;
      streamedLength = text.length;
    }

    if (loaded && wasRunning && !v.running) {
      let text = "";
      for (let k = list.length - 1; k >= 0; k -= 1) {
        const item = list[k]!;
        if (item.kind === "message" && item.role === "user") break;
        if (item.kind === "message" && item.role === "agent" && (item.text ?? "").trim() !== "") {
          text = item.text ?? "";
          break;
        }
      }
      if (text !== "") hooks.answered(text);
    }
    if (loaded && !wasRunning && v.running && v.acp.turnStartedMs != null) offset = now - v.acp.turnStartedMs;
    wasRunning = v.running;
    // Rows that arrived while the session was still replaying are history: they have no time, and no sound.
    if (v.phase !== "connecting") loaded = true;
  };

  const sync = (): void => {
    const v = port.view();
    if (!v) {
      if (lastView) {
        entries.clear();
        unfinished.clear();
        list = [];
        ids = [];
        dropped = -1;
        lastView = null;
        lastRevision = -1;
        viewSignal.set(null);
        version.update((n) => n + 1);
      }
      return;
    }
    if (lastView && v.revision === lastRevision) return;
    lastRevision = v.revision;
    lastEventAt = Date.now();
    pull(v);
    lastView = v;
    viewSignal.set(v);
    version.update((n) => n + 1);
  };

  untracked(sync);
  effect(() => {
    port.revision();
    untracked(sync);
  });

  // A clock only while a turn runs: an app at rest draws nothing.
  effect(() => {
    if (!viewSignal()?.running) return;
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  cleanup(() => viewSignal.set(null));

  /** The session's own clock now, in the units of `SessionItem.startedMs`; `null` until a live row has paired it with ours. */
  const sessionNow = (): number | null => (offset === null ? null : clock() - offset);

  let committed: { upTo: number; open: ReadonlyMap<string, boolean>; rows: Row[]; keys: Map<string, Row> } | null =
    null;
  let tailKeys = new Map<string, Row>();
  const rows = computed<readonly Row[]>(() => {
    version();
    clock();
    const open = choices();
    const v = viewSignal();
    const items = list;
    const tailAt = items.length === 0 ? 0 : unitStart(items, items.length - 1);
    const earlier =
      v?.earlierNotice ??
      (v && v.droppedItems > 0 ? "Earlier messages are not shown here; the machine still has them" : null);
    const input = { items, earlier, running: v?.running ?? false, open, nowMs: v?.running ? sessionNow() : null };
    if (!committed || committed.upTo !== tailAt || committed.open !== open || changedFrom < committed.upTo) {
      const built = buildRows({ ...input, earlier: tailAt === 0 ? null : earlier }, committed?.keys, {
        from: 0,
        to: tailAt,
      });
      committed = { upTo: tailAt, open, rows: built, keys: new Map(built.map((r) => [r.key, r])) };
    }
    changedFrom = Infinity;
    // The notice about earlier turns belongs to the top, which the built part owns (it is empty when the tail is everything).
    const tail = buildRows({ ...input, earlier: tailAt === 0 ? earlier : null }, tailKeys, {
      from: tailAt,
      to: items.length,
    });
    tailKeys = new Map(tail.map((r) => [r.key, r]));
    return committed.rows.concat(tail);
  });

  const working = computed<Working | null>(() => {
    const v = viewSignal();
    const now = clock();
    version();
    if (!v?.running) return null;
    const quiet = v.waiting.length === 0 ? Math.floor((now - lastEventAt) / 1000) : 0;
    const began = v.acp.turnStartedMs;
    const at = sessionNow();
    return {
      seconds: began == null || at === null ? null : Math.max(0, Math.round((at - began) / 1000)),
      quietMinutes: quiet >= QUIET_AFTER ? Math.floor(quiet / 60) : null,
    };
  });

  const toggle = (row: Row): void =>
    choose(
      row.key,
      row.kind === "work" ? row.work.open : row.kind === "tool" || row.kind === "thought" ? row.open : false,
    );

  const choose = (key: string, now: boolean): void => choices.update((m) => new Map(m).set(key, !now));

  const chosen = (key: string): boolean | undefined => choices().get(key);

  return { view: viewSignal, rows, working, toggle, choose, chosen };
}
