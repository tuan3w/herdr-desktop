import { Sessions } from "herdr-desktop/native";
import { cleanup, computed, effect, signal, untracked } from "nsh";

import type {
  ActionResult,
  PictureInput,
  SessionItem,
  SessionView,
  ToolItem,
  UnqueuedView,
} from "herdr-desktop/native";
import type { Accessor } from "nsh";

import { revision } from "#lib/herdr";
import { buildRows, type Row, type TurnCarry, unitStart } from "#lib/session-rows";
import { liveCount, liveLine, liveTail } from "#lib/session-text";

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
  /** Reads older turns of a terminal agent's log (`SessionView.observed.earlier` says whether there are any). */
  loadEarlier(): Promise<boolean>;
  /** Asks a terminal agent to stop its background task `key` (`observed.background[].stoppable`); absent where nothing can be stopped. */
  stopBackground?(key: string): Promise<ActionResult>;
  /** The read-only transcript of a terminal agent's subagent (`observed.subagents[].name`); absent where there is none to read. */
  subagent?(name: string): SubagentPort;
}

/** One subagent's transcript: a port that refuses every send (a subagent is steered through its parent), and how to open it. */
export interface SubagentPort {
  /** The chat id of the transcript (`sub:<paneId>#<name>`). */
  id: string;
  port: SessionPort;
  /** Starts reading the transcript; throws with words for the person. */
  open(): Promise<void>;
  /** Stops reading it. The subagent is not touched. */
  close(): void;
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
    loadEarlier: () => Promise.resolve(Sessions.loadEarlier(machine, id)),
    stopBackground: (key) => Sessions.stopBackground(machine, id, key),
    subagent: id.startsWith("pane:")
      ? (name) => {
          const pane = id.slice("pane:".length);
          const sub = `sub:${pane}#${name}`;
          return {
            id: sub,
            port: sessionPort(machine, sub),
            open: async () => {
              await Sessions.openSubagent(machine, pane, name);
            },
            close: () => Sessions.detach(machine, sub),
          };
        }
      : undefined,
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
  /** What it does now, as the one live line says it: `Running pnpm test`, `Reading 3 files`, `Thinking`. */
  toolLine: string;
  /**
   * Whole seconds the step the line names has run: the open call since this window saw it start, `Thinking` since the
   * last call ended or the turn began. `null` when that happened before the window looked: a time it did not watch
   * would be invented.
   */
  seconds: number | null;
  /** The last lines the call it names has printed, at most two: a peek at what it is doing, empty while it thinks. */
  tail: string[];
  /** Whole minutes without any event from the agent, once it is a minute or more: the honest stuck signal. */
  quietMinutes: number | null;
  /** The agent was heard from within the last minute and nothing waits for the person: the line may show it moving. */
  live: boolean;
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
  /** Asks for older turns of the log; they arrive above the rows in view, which keep their place. */
  loadEarlier(): void;
}

/** Rows read again on every revision: enough to follow a stream and a handful of parallel calls, however long the chat. */
const TAIL = 24;
/** Unfinished calls older than the tail that are read again; more would be stale ones that never report. */
const OPEN_CALLS = 8;
/** Seconds without an event after which `Quiet for` appears. */
const QUIET_AFTER = 60;

/** Pulls of a running session are at least this far apart: a streamed word is seen within it, and a burst is one pull. */
export const PULL_MS = 120;

/**
 * When to pull while chunks stream in: `ask(now)` answers `0` (pull now), a delay in ms (pull then: one timer, which
 * reads what is newest, so the last chunk is never lost) or `null` (that timer is already waiting). `ran(now)` says the
 * pull happened. Pure over the time it is given, so a test injects the clock.
 */
export function pacer(interval: number) {
  let last = Number.NEGATIVE_INFINITY;
  let waiting = false;
  return {
    ask(now: number): number | null {
      if (waiting) return null;
      const wait = Math.max(0, last + interval - now);
      waiting = wait > 0;
      return wait;
    },
    ran(now: number): void {
      last = now;
      waiting = false;
    },
  };
}

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
  /** The newest row id before this pull: older turns arrive with smaller ids and are history, not news. */
  let newest = -1;
  let streamedLength = 0;
  /** Agent messages `store` saw arrive since the hook last heard. */
  let arrived = 0;
  /** Lowest index whose row changed since the committed rows were built. */
  let changedFrom = Infinity;
  /** When this window saw each open call arrive (wall clock); a call it found already open has none. */
  const seenAt = new Map<number, number>();
  /** When the thinking the live line names began: the turn's start or the last call's end, as watched; `null` unknown. */
  let thinkingSince: number | null = null;

  const viewSignal = signal<SessionView | null>(null);
  const version = signal(0);
  const clock = signal(Date.now());
  const choices = signal<ReadonlyMap<string, boolean>>(new Map());

  const store = (item: SessionItem, index: number, now: number): void => {
    const old = entries.get(item.id);
    if (old && old.rev === item.rev) return;
    const live = !old && loaded && item.id > newest;
    if (live) {
      // A row that arrives live was started a moment ago: that pairs the session's clock with ours.
      if (item.startedMs != null) offset = now - item.startedMs;
      if (item.kind === "message" && item.role === "agent") arrived += 1;
    }
    entries.set(item.id, item);
    if (list[index]?.id === item.id) list[index] = item;
    if (item.tool && (item.tool.status === "pending" || item.tool.status === "inProgress")) {
      unfinished.add(item.id);
      if (live) seenAt.set(item.id, now);
    } else {
      unfinished.delete(item.id);
      seenAt.delete(item.id);
    }
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
    newest = ids.at(-1) ?? -1;
    const hadOpen = unfinished.size > 0;
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
    // Thinking starts when a watched turn starts or its last open call ends; a turn found running has no start.
    if (!v.running) thinkingSince = null;
    else if (loaded && (!wasRunning || (hadOpen && unfinished.size === 0))) thinkingSince = now;
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
        seenAt.clear();
        thinkingSince = null;
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
  // A running turn pulls at most every `PULL_MS`: each pull rebuilds rows and lays out text, so a stream faster than that
  // would cost frames for words nobody reads one by one. A session at rest pulls at once.
  const pace = pacer(PULL_MS);
  let pending: ReturnType<typeof setTimeout> | undefined;
  const pulled = (): void => {
    pending = undefined;
    pace.ran(Date.now());
    sync();
  };
  effect(() => {
    port.revision();
    untracked(() => {
      const wait = lastView?.running ? pace.ask(Date.now()) : 0;
      if (wait === null) return;
      if (wait === 0) pulled();
      else pending = setTimeout(pulled, wait);
    });
  });
  cleanup(() => clearTimeout(pending));

  // A clock only while a turn runs: an app at rest draws nothing.
  effect(() => {
    if (!viewSignal()?.running) return;
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  cleanup(() => viewSignal.set(null));

  /** The session's own clock now, in the units of `SessionItem.startedMs`; `null` until a live row has paired it with ours. */
  const sessionNow = (): number | null => (offset === null ? null : clock() - offset);

  let committed: {
    upTo: number;
    open: ReadonlyMap<string, boolean>;
    rows: Row[];
    keys: Map<string, Row>;
    carry: TurnCarry;
  } | null = null;
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
    const input = {
      items,
      earlier,
      running: v?.running ?? false,
      open,
      nowMs: v?.running ? sessionNow() : null,
      cwd: v?.cwd,
    };
    if (!committed || committed.upTo !== tailAt || committed.open !== open || changedFrom < committed.upTo) {
      const carry: TurnCarry = { groups: [] };
      const built = buildRows({ ...input, earlier: tailAt === 0 ? null : earlier }, committed?.keys, {
        from: 0,
        to: tailAt,
        carry,
      });
      committed = { upTo: tailAt, open, rows: built, keys: new Map(built.map((r) => [r.key, r])), carry };
    }
    changedFrom = Infinity;
    // The notice about earlier turns belongs to the top, which the built part owns (it is empty when the tail is everything).
    const tail = buildRows({ ...input, earlier: tailAt === 0 ? earlier : null }, tailKeys, {
      from: tailAt,
      to: items.length,
      // A copy: the tail adds its own groups to what the built part left, and the built part must stay as it was.
      carry: { groups: committed.carry.groups.slice() },
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
    const open: ToolItem[] = [];
    const seen: (number | undefined)[] = [];
    for (const id of [...unfinished].sort((x, y) => x - y)) {
      const tool = entries.get(id)?.tool;
      if (!tool) continue;
      open.push(tool);
      seen.push(seenAt.get(id));
    }
    // The clock counts what the line names: the calls it names, all of whose starts this window saw, or the thinking.
    const named = seen.slice(seen.length - liveCount(open));
    const since =
      open.length === 0 ? thinkingSince : named.some((t) => t === undefined) ? null : Math.min(...(named as number[]));
    return {
      toolLine: liveLine(open, v.cwd),
      tail: open.length > 0 ? liveTail(open.at(-1)!) : [],
      seconds: since === null ? null : Math.max(0, Math.floor((now - since) / 1000)),
      quietMinutes: quiet >= QUIET_AFTER ? Math.floor(quiet / 60) : null,
      live: v.waiting.length === 0 && quiet < QUIET_AFTER,
    };
  });

  const toggle = (row: Row): void => choose(row.key, row.kind === "work" ? row.work.open : false);

  const choose = (key: string, now: boolean): void => choices.update((m) => new Map(m).set(key, !now));

  const chosen = (key: string): boolean | undefined => choices().get(key);

  const loadEarlier = (): void => void port.loadEarlier();

  return { view: viewSignal, rows, working, toggle, choose, chosen, loadEarlier };
}
