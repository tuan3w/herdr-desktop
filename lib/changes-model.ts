import { Git, Herdr, Sessions } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, lifecycle, signal, untracked } from "nsh";

import type { BoardRow, ChangeView, DiffView, StatusView } from "herdr-desktop/native";
import type { Accessor } from "nsh";

import { confirmDestructive, notify } from "#kit";
import {
  agentsIn,
  branchText,
  checkoutName,
  isReviewed,
  type Item,
  type Kind,
  KIND_WORD,
  listItems,
  type Marks,
  type Note,
  noteOn,
  noteWhere,
  notesMessage,
  plusMinus,
  pruned,
  readMarks,
  statsText,
  stepFile,
  withCheckout,
  withMark,
} from "#lib/changes";
import { noteCount } from "#lib/changes-count";
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
  folded: Kind[];
  context: number;
  next: number;
}

const kept = new Map<string, Kept>();

/** The `reviewed` marks of every checkout, in the settings file: written through at every change. */
const reviewedStore = remembered<Record<string, Marks>>("changes.reviewed.v1", readMarks, () => ({}));

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const lines = (n: number): string => `${n} ${n === 1 ? "line" : "lines"}`;

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
  /** A read is running. */
  loading: Accessor<boolean>;
  /** The last read failed (the machine, git, a timeout), in words; `null` when it did not. */
  failure: Accessor<string | null>;
  /** The repository root as git named it, falling back to the folder asked for. */
  root: Accessor<string>;
  /** Changed files in the list's order, after the filter. */
  items: Accessor<Item[]>;
  files: Accessor<ChangeView[]>;
  query: Accessor<string>;
  setQuery: (q: string) => void;
  selected: Accessor<ChangeView | undefined>;
  select: (path: string) => void;
  /** The name of a section is closed in the list. */
  folded: Accessor<ReadonlySet<Kind>>;
  toggleSection: (kind: Kind) => void;
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
  const remember = () => kept.set(key, saved);

  const status = signal<StatusView | null>(null);
  const loading = signal(false);
  const failure = signal<string | null>(null);
  const query = signal("");
  const selectedPath = signal<string | null>(saved.selected);
  const folded = signal<ReadonlySet<Kind>>(new Set(saved.folded));
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
  const files = computed(() => status()?.files ?? []);
  const checkout = computed(() => `${machine}\n${root()}`);
  const marks = computed(() => reviewedStore.get()[checkout()]);
  const items = computed(() => listItems(files(), query(), marks(), folded()));
  const selected = computed(() => files().find((f) => f.path === selectedPath()));
  const reviewedCount = computed(() => files().filter((f) => isReviewed(marks(), f)).length);
  const agents = computed(() => (revision(), agentsIn(allRows(board()), machine, root())));
  const repoName = computed(() => checkoutName(machine, root()));
  const message = computed(() => notesMessage(notes(), repoName()));
  const branch = computed(() => (status() && !status()!.problem ? branchText(status()!) : ""));

  // ---- reading git ----

  let inflight = false;
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
      // The chip of a chat in this checkout shows the same number without reading git itself.
      const count = next.problem ? null : next.files.length;
      noteCount(machine, cwd, count);
      if (next.root) noteCount(machine, next.root, count);
      if (next.problem) return;
      const have = marks();
      const trimmed = pruned(have, next.files);
      if (trimmed !== have) reviewedStore.set(withCheckout(reviewedStore.get(), `${machine}\n${next.root}`, trimmed));
      const current = selectedPath();
      if (current === null || !next.files.some((f) => f.path === current)) {
        const first = untracked(items).find((i) => i.kind === "file");
        selectedPath.set(first?.kind === "file" ? first.change.path : null);
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
      if (!disposed) loading.set(false);
      if (again && !disposed) {
        again = false;
        void refresh();
      }
    }
  }

  // While in front and the window is on screen (focused or not: the person watches agents work beside another window):
  // read now, then again after `POLL_MS` (longer when a read is slow). A hidden tab and a window in the background
  // (minimised, another desktop) read nothing; coming back reads at once.
  effect(() => {
    if (!active() || lifecycle() === "background") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void refresh().finally(() => {
        timer = setTimeout(tick, Math.max(POLL_MS, lastMs * SLOW_FACTOR));
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

  async function readDiff(c: ChangeView): Promise<void> {
    const mine = ++diffSeq;
    diffLoading.set(true);
    diffFailure.set(null);
    try {
      const d = await Git.diff(machine, root(), c.path, c.oldPath ?? null, c.kind, context(), all().has(c.path));
      if (mine !== diffSeq || disposed) return;
      diff.set(d);
    } catch (e) {
      if (mine !== diffSeq || disposed) return;
      diff.set(null);
      diffFailure.set(reason(e));
    } finally {
      if (mine === diffSeq && !disposed) diffLoading.set(false);
    }
  }

  // The diff is read again when the file, its change or the way it is asked for changes; the old one stays on screen
  // meanwhile, so an agent's edit refreshes the view in place and does not blank it.
  effect(() => {
    const c = selected();
    const wanted = c ? `${c.path}|${c.fingerprint}|${context()}|${all().has(c.path)}` : "";
    if (wanted === shownKey) return;
    const sameFile = untracked(() => diff()?.path === c?.path);
    shownKey = wanted;
    if (!c) {
      diffSeq++;
      diff.set(null);
      diffFailure.set(null);
      diffLoading.set(false);
      return;
    }
    if (!sameFile) {
      diff.set(null);
      group.set(-1);
    }
    void untracked(() => readDiff(c));
  });

  // ---- notes ----

  const staleNotes = computed(() => {
    const changed = new Map(files().map((f) => [f.path, f.fingerprint]));
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
    const text = message();
    const count = notes().length;
    if (count === 0) return false;
    try {
      if (row.session) {
        const result = await Sessions.send(row.machine, row.paneId, text, []);
        if (result.kind !== "done" && result.kind !== "queued") {
          notify(result.message || "The notes were not sent", { lasting: true });
          return false;
        }
      } else {
        await Herdr.sendInput(row.machine, row.paneId, text, ["enter"]);
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
    loading,
    failure,
    root,
    items,
    files,
    query,
    setQuery: (q) => query.set(q),
    selected,
    select(path) {
      if (selectedPath() === path) return;
      selectedPath.set(path);
      saved.selected = path;
      remember();
      composing.set(null);
      const c = files().find((f) => f.path === path);
      if (c) announce(`${c.path}, ${KIND_WORD[c.kind]}, ${statsText(c)}`.replace(/, $/, ""));
    },
    folded,
    toggleSection(kind) {
      const next = new Set(folded());
      if (!next.delete(kind)) next.add(kind);
      folded.set(next);
      saved.folded = [...next];
      remember();
    },
    marks,
    reviewed: (c) => isReviewed(marks(), c),
    reviewedCount,
    toggleReviewed(c) {
      const on = !isReviewed(marks(), c);
      reviewedStore.set(withCheckout(reviewedStore.get(), checkout(), withMark(marks(), c, on)));
      announce(on ? `${c.path} marked reviewed` : `${c.path} marked not reviewed`);
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
      const order = untracked(items).flatMap((i) => (i.kind === "file" ? [i.change] : []));
      const next = stepFile(order, selectedPath(), by);
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
    message,
    sendNotes,
    revertFile,
    revertGroup,
    branch,
  };
}
