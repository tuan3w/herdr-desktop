/**
 * The rules of the toast manager, as Base UI's `ToastStore` has them, without a timer or a view: every method takes
 * the time (`now`, milliseconds) so a test moves it by hand and `notify.tsx` owns the one real timer.
 *
 * - A toast closes by itself after its `timeout` of *running* time. Time spent paused does not count: pausing keeps the
 *   time left and resuming starts from it, however many times it happens (`pause`/`resume`).
 * - The timers stand still while any reason holds: the pointer on the stack (`hover`), a toast's button having the
 *   keyboard focus (`focus`), the user having gone to the region by its shortcut (`region`). A toast added meanwhile
 *   starts paused. When the last toast is gone, the reasons are cleared: nothing is left to send their "released".
 * - A `loading` toast and a `timeout` of 0 never close by themselves.
 * - `limit` is how many toasts show. The rest are `limited`: kept, their timers running, shown again when a newer one
 *   goes (Base UI keeps them too; dropping would lose an Undo that is still valid). A `high` priority toast takes a
 *   place before any `low` one, so a warning is never pushed out by confirmations.
 * - The same `id` is the same toast: adding it again updates it in place and restarts its timer. One that is already
 *   closing is replaced by a fresh toast.
 * - A closed toast stays `ending` for `exitMs` (its exit animation), then it is removed.
 */

export type ToastType = "info" | "success" | "warning" | "error" | "loading";
export type ToastPriority = "low" | "high";
export type PauseReason = "hover" | "focus" | "region";

export interface ToastRecord<D> {
  readonly id: string;
  readonly text: string;
  readonly type: ToastType;
  readonly priority: ToastPriority;
  /** Milliseconds it runs before it closes; 0: it stays. */
  readonly timeout: number;
  readonly status: "present" | "ending";
  readonly limited: boolean;
  /** Counts the updates, so a view can tell that the text changed under the same id. */
  readonly version: number;
  readonly data: D;
  /** Running time left, `null` when the toast has no timer. */
  readonly remaining: number | null;
  /** When it last started running; `null` while paused, closing or without a timer. */
  readonly since: number | null;
  readonly endedAt: number | null;
}

export interface ToastInput<D> {
  id?: string;
  text: string;
  type?: ToastType;
  priority?: ToastPriority;
  /** Missing or `undefined`: the manager's default. */
  timeout?: number;
  data: D;
}

/** What `update` changes. A key that is present counts, even as `undefined` (`timeout`: back to the default). */
export interface ToastPatch<D> {
  text?: string;
  type?: ToastType;
  priority?: ToastPriority;
  timeout?: number | undefined;
  data?: D;
}

export interface ToastConfig {
  /** How many toasts show at once. */
  limit: number;
  /** How many toasts are kept at most, the hidden ones included: a loop that raises thousands must not grow the list. */
  keep: number;
  /** Default `timeout`. */
  timeout: number;
  /** How long a closed toast stays before it is removed; read at each use (0 under reduced motion). */
  exitMs: () => number;
}

export interface Settled<D> {
  /** Toasts whose timeout ran out: they are ending now. */
  closed: ToastRecord<D>[];
  removed: ToastRecord<D>[];
}

const hasTimer = (type: ToastType, timeout: number) => type !== "loading" && timeout > 0;

/** The manager `createToasts` makes. Each method that takes `now` first settles what ran out by then (`advance`). */
export interface Toasts<D> {
  /** Closes what ran out and removes what finished leaving. */
  advance(now: number): Settled<D>;
  /** Adds a toast and returns its id. `replaced` is true when it updated a toast that was already showing. */
  add(input: ToastInput<D>, now: number): { id: string; replaced: boolean; settled: Settled<D> };
  /** Changes a toast that shows. A missing or closing toast is left alone, so a late answer never reopens one. */
  update(id: string, patch: ToastPatch<D>, now: number): { done: boolean; settled: Settled<D> };
  /** Closes one toast, or all of them (no `id`). Returns the toasts that began closing. */
  close(id: string | undefined, now: number): { closed: ToastRecord<D>[]; settled: Settled<D> };
  pause(reason: PauseReason, now: number): Settled<D>;
  resume(reason: PauseReason, now: number): Settled<D>;
  paused(reason?: PauseReason): boolean;
  /** Milliseconds until something needs `advance`, `null` when nothing does (no timer is needed then). */
  nextDue(now: number): number | null;
  /** Oldest first, the ones the limit hides included. */
  all(): readonly ToastRecord<D>[];
  /** What is on screen, oldest first. */
  shown(): ToastRecord<D>[];
  get(id: string): ToastRecord<D> | undefined;
}

export function createToasts<D>(config: ToastConfig): Toasts<D> {
  let list: ToastRecord<D>[] = [];
  const pauses = new Set<PauseReason>();
  let seq = 0;

  const index = (id: string) => list.findIndex((t) => t.id === id);

  /** The toasts that show: the newest `limit` of the live ones, `high` before `low`; the closing ones always. */
  function relimit() {
    const live = list.filter((t) => t.status === "present");
    const ranked = live
      .map((t, at) => ({ t, at }))
      .sort((a, b) => Number(b.t.priority === "high") - Number(a.t.priority === "high") || b.at - a.at);
    const shows = new Set(ranked.slice(0, config.limit).map((r) => r.t.id));
    list = list.map((t) => {
      const limited = t.status === "present" && !shows.has(t.id);
      return t.limited === limited ? t : { ...t, limited };
    });
  }

  function running(): boolean {
    return pauses.size === 0;
  }

  /** Brings a timer from the state it was in to the one the new fields ask for. */
  function retimed(old: ToastRecord<D> | undefined, next: ToastRecord<D>, now: number, reset: boolean): ToastRecord<D> {
    if (next.status === "ending" || !hasTimer(next.type, next.timeout)) return { ...next, remaining: null, since: null };
    const keep = old && old.remaining !== null && !reset && old.timeout === next.timeout && old.type !== "loading";
    if (keep) return { ...next, remaining: old.remaining, since: old.since };
    return { ...next, remaining: next.timeout, since: running() ? now : null };
  }

  function freeze(now: number) {
    list = list.map((t) => (t.since === null || t.remaining === null ? t : { ...t, remaining: Math.max(0, t.remaining - (now - t.since)), since: null }));
  }

  function thaw(now: number) {
    list = list.map((t) => (t.remaining === null || t.since !== null || t.status === "ending" ? t : { ...t, since: now }));
  }

  function end(ids: ReadonlySet<string>, now: number): ToastRecord<D>[] {
    const ended: ToastRecord<D>[] = [];
    list = list.map((t) => {
      if (!ids.has(t.id) || t.status === "ending") return t;
      const next: ToastRecord<D> = { ...t, status: "ending", limited: false, remaining: null, since: null, endedAt: now };
      ended.push(next);
      return next;
    });
    if (ended.length > 0) relimit();
    return ended;
  }

  function clearIfEmpty() {
    if (list.length === 0) pauses.clear();
  }

  /** Closes what ran out and removes what finished leaving. Every other method starts by calling it. */
  function advance(now: number): Settled<D> {
    const due = new Set(list.filter((t) => t.since !== null && t.remaining !== null && now - t.since >= t.remaining).map((t) => t.id));
    const closed = end(due, now);
    const exit = config.exitMs();
    const removed = list.filter((t) => t.status === "ending" && t.endedAt !== null && now - t.endedAt >= exit);
    if (removed.length > 0) list = list.filter((t) => !removed.includes(t));
    clearIfEmpty();
    return { closed, removed };
  }

  function upsert(old: ToastRecord<D>, patch: ToastPatch<D>, now: number, reset: boolean): ToastRecord<D> {
    const timeout = "timeout" in patch ? (patch.timeout ?? config.timeout) : old.timeout;
    const next: ToastRecord<D> = {
      ...old,
      text: patch.text ?? old.text,
      type: patch.type ?? old.type,
      priority: patch.priority ?? old.priority,
      data: "data" in patch ? (patch.data as D) : old.data,
      timeout,
      version: old.version + 1,
    };
    const stored = retimed(old, next, now, reset || "timeout" in patch);
    list = list.map((t) => (t.id === old.id ? stored : t));
    relimit();
    return stored;
  }

  return {
    advance,

    /** Adds a toast. */
    add(input: ToastInput<D>, now: number): { id: string; replaced: boolean; settled: Settled<D> } {
      const settled = advance(now);
      const id = input.id ?? `toast-${seq++}`;
      const at = index(id);
      if (at >= 0 && list[at].status === "present") {
        upsert(list[at], { text: input.text, type: input.type ?? "info", priority: input.priority ?? "low", timeout: input.timeout, data: input.data }, now, true);
        return { id, replaced: true, settled };
      }
      // A toast that is closing gives its place to the new one, without anyone hearing it was removed.
      if (at >= 0) list = list.filter((t) => t.id !== id);
      const type = input.type ?? "info";
      const timeout = input.timeout ?? config.timeout;
      const fresh: ToastRecord<D> = {
        id,
        text: input.text,
        type,
        priority: input.priority ?? "low",
        timeout,
        status: "present",
        limited: false,
        version: 0,
        data: input.data,
        remaining: null,
        since: null,
        endedAt: null,
      };
      list = [...list, retimed(undefined, fresh, now, true)];
      relimit();
      const dropped = list.filter((t) => t.limited && t.priority === "low").slice(0, Math.max(0, list.length - config.keep));
      if (dropped.length > 0) {
        list = list.filter((t) => !dropped.includes(t));
        settled.closed.push(...dropped);
        settled.removed.push(...dropped);
      }
      return { id, replaced: false, settled };
    },

    /** Changes a toast that shows. A missing or closing toast is left alone, so a late answer never reopens one. */
    update(id: string, patch: ToastPatch<D>, now: number): { done: boolean; settled: Settled<D> } {
      const settled = advance(now);
      const at = index(id);
      if (at < 0 || list[at].status === "ending") return { done: false, settled };
      upsert(list[at], patch, now, false);
      return { done: true, settled };
    },

    /** Closes one toast, or all of them (no `id`). Returns the toasts that began closing. */
    close(id: string | undefined, now: number): { closed: ToastRecord<D>[]; settled: Settled<D> } {
      const settled = advance(now);
      const ids = new Set(id === undefined ? list.map((t) => t.id) : [id]);
      return { closed: end(ids, now), settled };
    },

    pause(reason: PauseReason, now: number): Settled<D> {
      const settled = advance(now);
      if (pauses.size === 0 && list.length > 0) freeze(now);
      if (list.length > 0) pauses.add(reason);
      return settled;
    },

    resume(reason: PauseReason, now: number): Settled<D> {
      const settled = advance(now);
      if (pauses.delete(reason) && pauses.size === 0) thaw(now);
      return settled;
    },

    paused: (reason?: PauseReason) => (reason ? pauses.has(reason) : pauses.size > 0),

    /** Milliseconds until something needs `advance`, `null` when nothing does (no timer is needed then). */
    nextDue(now: number): number | null {
      let soonest: number | null = null;
      const consider = (at: number) => {
        soonest = soonest === null ? at : Math.min(soonest, at);
      };
      for (const t of list) {
        if (t.since !== null && t.remaining !== null) consider(t.since + t.remaining);
        else if (t.status === "ending" && t.endedAt !== null) consider(t.endedAt + config.exitMs());
      }
      return soonest === null ? null : Math.max(0, soonest - now);
    },

    /** Oldest first, the ones the limit hides included. */
    all: (): readonly ToastRecord<D>[] => list,

    /** What is on screen, oldest first. */
    shown: (): ToastRecord<D>[] => list.filter((t) => !t.limited),

    get: (id: string): ToastRecord<D> | undefined => list[index(id)],
  };
}

export interface UndoEntry {
  readonly id: string;
  readonly run: () => void;
  /** The time until which Cmd+Z still undoes it once its toast is no longer on screen. */
  readonly until: number;
}

/**
 * The undo that Cmd+Z runs: the newest whose toast is still on screen, or whose time (`until`) has not run out. A toast
 * that is hidden (Escape, a swipe, the limit) does not take the user's way back with it.
 */
export function newestUndo(entries: readonly UndoEntry[], now: number, onScreen: (id: string) => boolean): UndoEntry | undefined {
  return entries.findLast((e) => onScreen(e.id) || now < e.until);
}

/** The entries that can still be run: the ones `newestUndo` could pick. */
export function liveUndos(entries: readonly UndoEntry[], now: number, onScreen: (id: string) => boolean): UndoEntry[] {
  return entries.filter((e) => onScreen(e.id) || now < e.until);
}
