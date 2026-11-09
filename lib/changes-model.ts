import { Git, Herdr, Sessions } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, lifecycle, signal, untracked } from "nsh";

import type { BoardRow, ChangeView, DiffView, StatusView } from "herdr-desktop/native";
import type { Accessor } from "nsh";

import { confirmDestructive, notify } from "#kit";
import {
  agentsIn,
  branchText,
  checkoutName,
  isBulky,
  isReviewed,
  type Item,
  KIND_WORD,
  LOCAL,
  groupOpen,
  listItems,
  type Marks,
  type Note,
  noteOn,
  matches,
  noteWhere,
  notesMessage,
  orderOf,
  plusMinus,
  pruned,
  readMarks,
  statsText,
  stepFile,
  withCheckout,
  withMark,
} from "#lib/changes";
import { noteCount } from "#lib/changes-count";
import { keptStatus, wantedKey } from "#lib/changes-kept";
import { scopeFiles, sessionPaths } from "#lib/changes-scope";
import { groupFiles, NEW_ROOT } from "#lib/changes-tree";
import { changesKey } from "#lib/dock";
import { allRows, board, revision } from "#lib/herdr";
import { remembered } from "#lib/pane-memory";

/**
 * One Changes tab's state: what git says about a checkout (read again every few seconds while the tab is in front, and
 * when an agent of the checkout changes state), the file being reviewed and its diff, the notes the person is writing and
 * what to do with them. It is a function of the tab so two checkouts never share a selection, and it keeps what a layout
 * swap would lose (notes, selection, folded groups) in `kept`, by the tab's key, like a draft (`lib/view-state.ts`).
 */

/** How often a visible tab reads git again, at least; a slow repository stretches it (`SLOW_FACTOR` times what a read took). */
export const POLL_MS = 5000;
const SLOW_FACTOR = 4;
/** Quiet time after an agent's state changes before the tab reads git: a burst of tool calls is one read. */
export const TURN_MS = 400;
/** The unchanged lines asked for around each change, in the order `More context` steps through them. */
export const CONTEXTS = [3, 12, 10000] as const;

/** What a tab keeps beyond its life. */
interface Kept {
  notes: Note[];
  selected: string | null;
  folded: string[];
  context: number;
  next: number;
  /** What git said last, and when (`Date.now()`): a tab opened again paints it at once and reads git behind it. */
  status?: StatusView;
  statusAt?: number;
  /** The diff on screen and the `wantedKey` it was read for: shown again only when the same file, change and context are asked for. */
  diff?: DiffView;
  diffKey?: string;
}

const kept = new Map<string, Kept>();

/**
 * Checkouts whose status and diff are kept. They are the bulk of `kept` (a status lists every changed file); the notes,
 * selection and folds of a checkout are small and stay for all of them.
 */
const KEPT_HEAVY = 8;

/** Makes `key` the newest and lets the status and diff of all but the newest `KEPT_HEAVY` checkouts go. */
function keep(key: string, entry: Kept): void {
  kept.delete(key);
  kept.set(key, entry);
  let heavy = 0;
  for (const k of [...kept.keys()].reverse()) {
    const e = kept.get(k)!;
    if (!e.status || ++heavy <= KEPT_HEAVY) continue;
    delete e.status;
    delete e.statusAt;
    delete e.diff;
    delete e.diffKey;
  }
}

/** Forgets what every checkout's tab kept: a test opens a tab that was never opened before. */
export function forgetKept(): void {
  kept.clear();
}

/** The `reviewed` marks of every checkout, in the settings file: written through at every change. */
const reviewedStore = remembered<Record<string, Marks>>("changes.reviewed.v1", readMarks, () => ({}));

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const lines = (n: number): string => `${n} ${n === 1 ? "line" : "lines"}`;

const UPDATING = "Updating the changes; try again in a moment";

/** What reverting a file loses, in the words a confirmation names it with. */
export function lostByFile(c: Pick<ChangeView, "kind" | "added" | "removed" | "path" | "oldPath">): string {
  const edits = c.added == null || c.removed == null ? "its edits" : plusMinus(c.added, c.removed);
  switch (c.kind) {
    case "untracked":
      return `${c.path} is not in git, so it is deleted for good (${c.added == null ? "its content" : lines(c.added)}). You can undo this for ten minutes.`;
    case "added":
      return `${c.path} is new: it is removed from git and deleted from the folder (${c.added == null ? "its content" : lines(c.added)}). You can undo this for ten minutes.`;
    case "deleted":
      return `${c.path} comes back as the last commit has it. You can undo this for ten minutes.`;
    case "renamed":
      return `${c.path} moves back to ${c.oldPath ?? "its old name"} and its edits (${edits}) are lost. You can undo this for ten minutes.`;
    default:
      return `Its edits (${edits}) are lost and ${c.path} goes back to the last commit. You can undo this for ten minutes.`;
  }
}

export interface ChangesModel {
  readonly key: string;
  readonly machine: string;
  readonly cwd: string;
  /** What git said last, `null` before the first answer. */
  status: Accessor<StatusView | null>;
  /** The status shown is the one kept from the last visit and git has not answered since: nothing is reverted or sent from it. */
  stale: Accessor<boolean>;
  /** A read is running. */
  loading: Accessor<boolean>;
  /** The last read failed (the machine, git, a timeout), in words; `null` when it did not. */
  failure: Accessor<string | null>;
  /** The repository root as git named it, falling back to the folder asked for. */
  root: Accessor<string>;
  /** Changed files in the list's order, after the filter. */
  items: Accessor<Item[]>;
  /** The files of the chosen scope. */
  files: Accessor<ChangeView[]>;
  /** The files of the chosen scope in the list's order, folded groups and the filter included: what `j` and `k` step through. */
  order: Accessor<ChangeView[]>;
  /** Where the selected file stands in `order`: `3` of `7`; 0 when none is. */
  position: Accessor<{ at: number; of: number }>;
  /** The tab was opened by a chat: the files its agent edited are a scope of their own. */
  hasSession: Accessor<boolean>;
  /** `session`: the files the agent edited. `all`: everything git reports. Always `all` without a session. */
  scope: Accessor<"session" | "all">;
  setScope: (scope: "session" | "all") => void;
  /** How many files each scope holds (the session's: those among them that git reports a change for). */
  counts: Accessor<{ session: number; all: number }>;
  sort: Accessor<"path" | "size">;
  setSort: (sort: "path" | "size") => void;
  /** The selected file is a big new file (data, output): its change is not read until `openAnyway`. */
  held: Accessor<boolean>;
  openAnyway: () => void;
  query: Accessor<string>;
  setQuery: (q: string) => void;
  selected: Accessor<ChangeView | undefined>;
  select: (path: string) => void;
  /** The keys of the groups (`groupFiles`) the person turned from how they start: open, except the section of unknown files. */
  folded: Accessor<ReadonlySet<string>>;
  toggleSection: (group: string) => void;
  marks: Accessor<Marks | undefined>;
  reviewed: (c: ChangeView) => boolean;
  reviewedCount: Accessor<number>;
  toggleReviewed: (c: ChangeView) => void;
  diff: Accessor<DiffView | null>;
  diffLoading: Accessor<boolean>;
  diffFailure: Accessor<string | null>;
  context: Accessor<number>;
  cycleContext: () => void;
  showAll: Accessor<boolean>;
  setShowAll: () => void;
  /** The change group in view (the diff view's own count, from 0), -1 before the first step. */
  group: Accessor<number>;
  setGroup: (i: number) => void;
  /** The diff view's steps, given by it once it is drawn. */
  attach: (nav: { next(): void; previous(): void } | null) => void;
  stepChange: (by: 1 | -1) => void;
  stepFile: (by: 1 | -1) => void;
  refresh: (announceResult?: boolean) => Promise<void>;
  notes: Accessor<Note[]>;
  /** The note being written: on which group, or `null`. */
  composing: Accessor<{ group: number } | null>;
  draft: Accessor<string>;
  setDraft: (text: string) => void;
  startNote: () => void;
  saveNote: () => void;
  cancelNote: () => void;
  removeNote: (id: number) => void;
  /** Notes whose file has changed since they were written. */
  staleNotes: Accessor<ReadonlySet<number>>;
  agents: Accessor<BoardRow[]>;
  repoName: Accessor<string>;
  /** The machine's name for a header, empty for this computer (nothing to say) and while the board does not know it. */
  machineName: Accessor<string>;
  /** The one message the notes make. */
  message: Accessor<string>;
  sendNotes: (row: BoardRow) => Promise<boolean>;
  revertFile: (c: ChangeView) => Promise<void>;
  revertGroup: () => Promise<void>;
  /** How the branch reads: `main · 2 ahead`. */
  branch: Accessor<string>;
}

/**
 * The model of the Changes tab of `cwd` on `machine`. `active` is whether the tab is in front: only then is git read on a
 * timer, and a tab that comes to the front reads at once. Call while a component is being built (`cleanup`).
 */
export function createChanges(machine: string, cwd: string, active: Accessor<boolean>): ChangesModel {
  const key = changesKey(machine, cwd);
  const saved: Kept = kept.get(key) ?? { notes: [], selected: null, folded: [], context: CONTEXTS[0], next: 1 };
  const remember = () => keep(key, saved);

  const opened = keptStatus(saved, Date.now());
  const status = signal<StatusView | null>(opened);
  const stale = signal(opened !== null);
  const loading = signal(false);
  const failure = signal<string | null>(null);
  const query = signal("");
  const selectedPath = signal<string | null>(saved.selected);
  const folded = signal<ReadonlySet<string>>(new Set(saved.folded));
  const sort = signal<"path" | "size">("path");
  const forced = signal<ReadonlySet<string>>(new Set());
  const diff = signal<DiffView | null>(null);
  const diffLoading = signal(false);
  const diffFailure = signal<string | null>(null);
  const context = signal<number>(saved.context);
  const all = signal<ReadonlySet<string>>(new Set());
  const group = signal(-1);
  const notes = signal<Note[]>(saved.notes);
  const composing = signal<{ group: number } | null>(null);
  const draft = signal("");
  let nav: { next(): void; previous(): void } | null = null;
  let disposed = false;
  cleanup(() => {
    disposed = true;
  });

  const root = computed(() => status()?.root || cwd);
  const everything = computed(() => status()?.files ?? []);
  const session = sessionPaths(machine, cwd);
  const hasSession = computed(() => session() !== null);
  const scope = signal<"session" | "all">(untracked(session) ? "session" : "all");
  // A chat that opens the tab (again) brings the tab to its files; anything else leaves the choice as it is.
  effect(() => {
    scope.set(session() ? "session" : "all");
  });
  const bases = () => {
    let real = cwd;
    try {
      real = Git.canonicalPath(machine, cwd);
    } catch {
      // A machine that cannot answer: the folder as given still matches paths written as given.
    }
    return [root(), cwd, real];
  };
  const mine = computed(() => {
    const paths = session();
    return paths ? scopeFiles(everything(), paths, { root: root(), bases: bases() }) : [];
  });
  const files = computed(() => (hasSession() && scope() === "session" ? mine() : everything()));
  const counts = computed(() => ({ session: mine().length, all: everything().length }));
  const treeOptions = () => ({ sort: sort(), keep: new Set(mine().map((f) => f.path)) });
  const order = computed(() =>
    orderOf(
      files().filter((f) => matches(f, query())),
      treeOptions(),
    ),
  );
  const checkout = computed(() => `${machine}\n${root()}`);
  const marks = computed(() => reviewedStore.get()[checkout()]);
  const items = computed(() => listItems(files(), query(), marks(), folded(), treeOptions()));
  const position = computed(() => {
    const at = order().findIndex((f) => f.path === selectedPath());
    return { at: at + 1, of: order().length };
  });
  const held = computed(() => {
    const c = files().find((f) => f.path === selectedPath());
    return c !== undefined && isBulky(c) && !forced().has(c.path);
  });
  const selected = computed(() => files().find((f) => f.path === selectedPath()));
  const reviewedCount = computed(() => files().filter((f) => isReviewed(marks(), f)).length);
  const agents = computed(() => (revision(), agentsIn(allRows(board()), machine, root(), Git.canonicalPath)));
  const repoName = computed(() => checkoutName(machine, root()));
  const machineName = computed(() =>
    machine === LOCAL ? "" : (board().projects.find((p) => p.machine === machine)?.machineName ?? machine),
  );
  const message = computed(() => notesMessage(notes(), repoName()));
  const branch = computed(() => (status() && !status()!.problem ? branchText(status()!) : ""));

  // ---- reading git ----

  let inflight = false;
  let settled = false;
  let again = false;
  let lastMs = 0;

  async function refresh(announceResult = false): Promise<void> {
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    loading.set(true);
    const started = performance.now();
    try {
      const next = await Git.status(machine, cwd);
      if (disposed) return;
      failure.set(null);
      status.set(next);
      saved.status = next;
      saved.statusAt = Date.now();
      remember();
      // The chip of a chat in this checkout shows the same number without reading git itself.
      const count = next.problem ? null : next.files.length;
      noteCount(machine, cwd, count);
      if (next.root) noteCount(machine, next.root, count);
      if (next.problem) return;
      const have = marks();
      const trimmed = pruned(have, next.files);
      if (trimmed !== have) reviewedStore.set(withCheckout(reviewedStore.get(), `${machine}\n${next.root}`, trimmed));
      // A session that touched nothing git still reports (it was committed since) opens on everything instead of nothing.
      if (!settled) {
        settled = true;
        if (untracked(hasSession) && untracked(mine).length === 0) scope.set("all");
      }
      const current = selectedPath();
      if (current === null || !untracked(files).some((f) => f.path === current)) {
        const first = untracked(order)[0];
        if (first) reveal(first.path);
        selectedPath.set(first?.path ?? null);
        saved.selected = first?.path ?? null;
        remember();
      }
      if (announceResult)
        announce(
          next.files.length === 0
            ? "No changes"
            : `${next.files.length} ${next.files.length === 1 ? "file" : "files"} changed`,
        );
    } catch (e) {
      if (disposed) return;
      failure.set(reason(e));
      if (announceResult) announce(`Could not read the changes: ${reason(e)}`);
    } finally {
      lastMs = performance.now() - started;
      inflight = false;
      if (!disposed) {
        loading.set(false);
        stale.set(false);
      }
      if (again && !disposed) {
        again = false;
        void refresh();
      }
    }
  }

  // While in front and the window is on screen (focused or not: the person watches agents work beside another window):
  // read now, then again after `POLL_MS` (longer when a read is slow). A hidden tab reads nothing, and a window in the
  // background (minimised, another desktop) polls nothing; coming back reads at once. A tab with nothing to show yet
  // still reads once in the background: macOS reports `background` for a window that opens covered (or that a test host
  // never presents), and the tab stayed on its loading skeleton for good.
  effect(() => {
    if (!active()) return;
    const background = lifecycle() === "background";
    if (background && untracked(status) !== null && !untracked(stale)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void refresh().finally(() => {
        if (!background) timer = setTimeout(tick, Math.max(POLL_MS, lastMs * SLOW_FACTOR));
      });
    };
    untracked(tick);
    return () => clearTimeout(timer);
  });

  // An agent of this checkout starting, finishing or asking changes the files: read soon after, once for a burst.
  let first = true;
  let soon: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(soon));
  effect(() => {
    const states = agents()
      .map((r) => `${r.key}:${r.status}`)
      .join(",");
    void states;
    if (first) {
      first = false;
      return;
    }
    if (!untracked(active) || untracked(lifecycle) === "background") return;
    clearTimeout(soon);
    soon = setTimeout(() => void refresh(), TURN_MS);
  });

  // ---- the diff of the selected file ----

  let diffSeq = 0;
  let shownKey = "";
  const forgetDiff = () => {
    delete saved.diff;
    delete saved.diffKey;
    remember();
  };

  // A diff kept from the last visit is drawn again at once, and `shownKey` says it is what the selection wants, so the
  // effect below neither blanks nor reads it before git has answered; a changed fingerprint then reads it as ever.
  const keptKey = untracked(() => wantedKey(selected(), context(), all().has(selectedPath() ?? ""), held()));
  if (saved.diff && keptKey !== "" && saved.diffKey === keptKey) {
    diff.set(saved.diff);
    shownKey = keptKey;
  }

  async function readDiff(c: ChangeView, wanted: string): Promise<void> {
    const mine = ++diffSeq;
    diffLoading.set(true);
    diffFailure.set(null);
    try {
      const d = await Git.diff(machine, root(), c.path, c.oldPath ?? null, c.kind, context(), all().has(c.path));
      if (mine !== diffSeq || disposed) return;
      diff.set(d);
      saved.diff = d;
      saved.diffKey = wanted;
      remember();
    } catch (e) {
      if (mine !== diffSeq || disposed) return;
      diff.set(null);
      forgetDiff();
      diffFailure.set(reason(e));
    } finally {
      if (mine === diffSeq && !disposed) diffLoading.set(false);
    }
  }

  // The diff is read again when the file, its change or the way it is asked for changes; the old one stays on screen
  // meanwhile, so an agent's edit refreshes the view in place and does not blank it.
  effect(() => {
    const c = selected();
    const holding = held();
    const wanted = wantedKey(c, context(), all().has(c?.path ?? ""), holding);
    if (wanted === shownKey) return;
    const sameFile = untracked(() => diff()?.path === c?.path);
    shownKey = wanted;
    if (!c || holding) {
      diffSeq++;
      diff.set(null);
      forgetDiff();
      diffFailure.set(null);
      diffLoading.set(false);
      return;
    }
    if (!sameFile) {
      diff.set(null);
      forgetDiff();
      group.set(-1);
    }
    void untracked(() => readDiff(c, wanted));
  });

  /** Opens the groups that hide `path` (the closed section of unknown files, its folder), so a selected row is one you can see. */
  function reveal(path: string): void {
    if (untracked(items).some((i) => i.kind === "file" && i.change.path === path)) return;
    const g = groupFiles(untracked(files), untracked(treeOptions)).find((x) => x.files.some((f) => f.path === path));
    if (!g) return;
    const next = new Set(untracked(folded));
    for (const key of g.quiet ? [NEW_ROOT, g.key] : [g.key]) {
      if (groupOpen(next, key)) continue;
      if (!next.delete(key)) next.add(key);
    }
    folded.set(next);
    saved.folded = [...next];
    remember();
  }

  // ---- notes ----

  const staleNotes = computed(() => {
    const changed = new Map(everything().map((f) => [f.path, f.fingerprint]));
    return new Set(
      notes()
        .filter((n) => changed.get(n.path) !== n.fingerprint)
        .map((n) => n.id),
    );
  });

  function setNotes(next: Note[]): void {
    notes.set(next);
    saved.notes = next;
    remember();
  }

  const current = () => {
    const d = diff();
    const g = group();
    return d && g >= 0 ? d.groups[g] : undefined;
  };

  function startNote(): void {
    const d = diff();
    if (!d || d.groups.length === 0) {
      announce(
        d?.binary
          ? "A binary file has no lines to note: note the file in your message"
          : "Nothing in this file to note on",
      );
      return;
    }
    if (group() < 0) nav?.next();
    const g = group() >= 0 ? group() : 0;
    const existing = notes().find((n) => n.path === d.path && n.group === g);
    draft.set(existing?.text ?? "");
    composing.set({ group: g });
  }

  function saveNote(): void {
    const at = composing();
    const d = diff();
    const text = draft().trim();
    const change = selected();
    if (!at || !d || !change) return;
    const g = d.groups[at.group];
    composing.set(null);
    draft.set("");
    if (!g || text === "") return;
    const others = notes().filter((n) => !(n.path === d.path && n.group === at.group));
    const id = notes().find((n) => n.path === d.path && n.group === at.group)?.id ?? saved.next++;
    const note = noteOn(d, g, text, id, change.fingerprint);
    setNotes([...others, note].sort((a, b) => a.id - b.id));
    announce(`Note added on ${noteWhere(note)}, ${notes().length} ${notes().length === 1 ? "note" : "notes"} to send`);
  }

  // ---- acting ----

  async function undoRevert(id: string, what: string): Promise<void> {
    try {
      await Git.undo(machine, root(), id);
      notify(`Brought back ${what}`);
    } catch (e) {
      notify(reason(e), { lasting: true });
    }
    await refresh();
  }

  async function revertFile(c: ChangeView): Promise<void> {
    // The Rust side checks no fingerprint for a whole file, so a list kept from the last visit must not answer for it.
    if (stale()) {
      announce(UPDATING);
      return;
    }
    const yes = await confirmDestructive({
      title: `Revert ${c.path}?`,
      description: lostByFile(c),
      action: "Revert file",
    });
    if (!yes) return;
    try {
      const done = await Git.revertFile(machine, root(), c.path);
      notify(`Reverted ${c.path}`, { undo: () => void undoRevert(done.id, c.path) });
      announce(`Reverted ${c.path}. Undo is available for ten minutes`);
    } catch (e) {
      notify(reason(e), { lasting: true });
    }
    await refresh();
  }

  async function revertGroup(): Promise<void> {
    if (stale()) {
      announce(UPDATING);
      return;
    }
    const d = diff();
    const g = current();
    const c = selected();
    if (!d || !g || !c) return;
    const n = d.groups.length;
    const part = `${g.added > 0 ? `${lines(g.added)} added` : ""}${g.added > 0 && g.removed > 0 ? " and " : ""}${g.removed > 0 ? `${lines(g.removed)} removed` : ""}`;
    const yes = await confirmDestructive({
      title: `Revert change ${g.index + 1} of ${n} in ${d.path}?`,
      description: `${part} (around line ${g.line}) go back to how the last commit has them. The rest of the file stays as it is. You can undo this for ten minutes.`,
      action: "Revert change",
    });
    if (!yes) return;
    try {
      const done = await Git.revertGroup(machine, root(), d.path, g.index, d.fingerprint);
      notify(`Reverted change ${g.index + 1} in ${d.path}`, { undo: () => void undoRevert(done.id, d.path) });
      announce(`Reverted change ${g.index + 1} of ${n}. Undo is available for ten minutes`);
    } catch (e) {
      notify(reason(e), { lasting: true });
    }
    group.set(-1);
    await refresh();
  }

  async function sendNotes(row: BoardRow): Promise<boolean> {
    if (stale()) {
      announce(UPDATING);
      return false;
    }
    const text = message();
    const count = notes().length;
    if (count === 0) return false;
    try {
      if (row.session) {
        const result = await Sessions.send(row.machine, row.paneId, text, [], []);
        if (result.kind !== "done" && result.kind !== "queued") {
          notify(result.message || "The notes were not sent", { lasting: true });
          return false;
        }
      } else {
        await Herdr.prompt(row.machine, row.paneId, text);
      }
    } catch (e) {
      notify(`Could not send the notes: ${reason(e)}`, { lasting: true });
      return false;
    }
    setNotes([]);
    const said = `Sent ${count} ${count === 1 ? "note" : "notes"} to ${row.name}`;
    notify(said);
    announce(said);
    return true;
  }

  return {
    key,
    machine,
    cwd,
    status,
    stale,
    loading,
    failure,
    root,
    items,
    files,
    order,
    position,
    hasSession,
    scope,
    setScope(next) {
      if (next === scope()) return;
      scope.set(next);
      announce(
        next === "session"
          ? `This session: ${counts().session} of ${counts().all} changed files`
          : `Everything: ${counts().all} changed files`,
      );
    },
    counts,
    sort,
    setSort(next) {
      sort.set(next);
      announce(next === "size" ? "Biggest change first" : "By name");
    },
    held,
    openAnyway() {
      const path = selectedPath();
      if (path !== null) forced.set(new Set(forced()).add(path));
    },
    query,
    setQuery: (q) => query.set(q),
    selected,
    select(path) {
      if (selectedPath() === path) return;
      reveal(path);
      selectedPath.set(path);
      saved.selected = path;
      remember();
      composing.set(null);
      const c = files().find((f) => f.path === path);
      if (c) announce(`${c.path}, ${KIND_WORD[c.kind]}, ${statsText(c)}`.replace(/, $/, ""));
    },
    folded,
    toggleSection(group) {
      const next = new Set(folded());
      if (!next.delete(group)) next.add(group);
      folded.set(next);
      saved.folded = [...next];
      remember();
    },
    marks,
    reviewed: (c) => isReviewed(marks(), c),
    reviewedCount,
    toggleReviewed(c) {
      const on = !isReviewed(marks(), c);
      const next = withMark(marks(), c, on);
      reviewedStore.set(withCheckout(reviewedStore.get(), checkout(), next));
      if (!on) {
        announce(`${c.path} marked not reviewed`);
        return;
      }
      // Marking is how a review moves: on to the next file nobody has reviewed, below this one in the list. It never turns back.
      const list = untracked(order);
      const after = list.slice(list.findIndex((f) => f.path === c.path) + 1).find((f) => !isReviewed(next, f));
      if (after) {
        this.select(after.path);
        announce(`${c.path} marked reviewed. Next: ${after.path}`);
      } else if (list.every((f) => isReviewed(next, f))) announce("All reviewed");
      else announce(`${c.path} marked reviewed. No unreviewed file below it`);
    },
    diff,
    diffLoading,
    diffFailure,
    context,
    cycleContext() {
      const at = CONTEXTS.findIndex((n) => n === context());
      const next = CONTEXTS[(at + 1) % CONTEXTS.length];
      context.set(next);
      saved.context = next;
      remember();
      announce(
        next >= 10000 ? "Showing the whole file around each change" : `Showing ${lines(next)} around each change`,
      );
    },
    showAll: computed(() => selectedPath() !== null && all().has(selectedPath()!)),
    setShowAll() {
      const path = selectedPath();
      if (path === null) return;
      all.set(new Set(all()).add(path));
    },
    group,
    setGroup: (i) => group.set(i),
    attach(next) {
      nav = next;
    },
    stepChange(by) {
      if (by > 0) nav?.next();
      else nav?.previous();
    },
    stepFile(by) {
      const next = stepFile(untracked(order), selectedPath(), by);
      if (next !== null) this.select(next);
    },
    refresh,
    notes,
    composing,
    draft,
    setDraft: (text) => draft.set(text),
    startNote,
    saveNote,
    cancelNote() {
      composing.set(null);
      draft.set("");
    },
    removeNote(id) {
      const gone = notes().find((n) => n.id === id);
      setNotes(notes().filter((n) => n.id !== id));
      if (gone) announce(`Note on ${noteWhere(gone)} removed`);
    },
    staleNotes,
    agents,
    repoName,
    machineName,
    message,
    sendNotes,
    revertFile,
    revertGroup,
    branch,
  };
}
