import { Compose, Files, Git, Herdr } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, keymap, signal, untracked } from "nsh";

import type { ActionResult, DroppedView, MentionsView, PeekView, PictureView, SessionView } from "herdr-desktop/native";
import type { Accessor, InputRef, Signal } from "nsh";
import type { Bounds } from "nsh/types";

import { notify } from "#kit";
import {
  acceptMention,
  activeRefs,
  emptyHistory,
  forTerminal,
  type History,
  insertToken,
  keepAtomic,
  looksBinary,
  lineCount,
  type Mention,
  type MentionRef,
  mentionAt,
  nextNumber,
  type Outgoing,
  outgoing,
  PASTE_COLLAPSE,
  type PasteRef,
  type PictureRef,
  plainText,
  recallDown,
  recallUp,
  type Ref,
  remember,
  sendable,
  refKey,
  spansOf,
  tokenOf,
  withoutRef,
} from "#lib/composer-refs";
import { sessionKey } from "#lib/dock";
import { sending } from "#lib/files";
import { changedTick, noteMentioned, readChanged, relativeIn, searchMentions, warmMentions } from "#lib/mention";
import { noteSent, slashMemory } from "#lib/pane-memory";
import type { SessionPort } from "#lib/session";
import { MAX_FILES, restoreText } from "#lib/session-compose";
import { composerOff } from "#lib/session-text";
import { enterNewline, picturesOriginal } from "#lib/settings";
import { byKind, hintFor, matchCommands, type SlashCommand } from "#lib/slash";
import { withBuiltIns } from "#lib/slash-builtins";
import { draftOf, setDraft } from "#lib/view-state";

/**
 * The message box of a chat as a model: the words, what they point at (files, folders, pictures, long pastes), the two
 * lists that open from them (`@` and `/`), what was sent before (Up), and sending. `components/session-composer.tsx` draws
 * it; this file decides. Everything that reads a disk, the clipboard or a machine goes through `Compose` and runs off the
 * UI thread: pasting a 4 MB screenshot never stops a keystroke.
 *
 * Rules worth knowing before changing anything (`design/composer.md` has the reasons):
 * - nothing the person typed or attached is ever dropped: a refused send, an agent that did not take the message and a
 *   message taken back from the queue all put it back, chips included; Escape never clears the box;
 * - a reference lives while its token is in the words (`lib/composer-refs.ts`), so Undo brings a chip back;
 * - a picture an agent cannot see is said so on its thumbnail, and sending is refused (or sent as a path) rather than
 *   dropped without a word.
 */

/** A send that is not for this reason or that: `done` and `queued` took effect; every other kind sent nothing. */
const refused = (r: ActionResult): boolean => r.kind !== "done" && r.kind !== "queued";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What the box tells the screen: `components/session-composer.tsx` is only a view of it. */
export interface Composer {
  value: Accessor<string>;
  /** The caret has moved, or text was set from outside: where the input's selection belongs. */
  selection: Accessor<{ at: number; seq: number } | null>;
  /** Files added with `+` or a drop that are outside the project (the project's own are mentions). */
  attached: Accessor<string[]>;
  /** Chips that stand in the words now, in the order they appear. */
  chips: Accessor<Ref[]>;
  pictures: Accessor<PictureRef[]>;
  /** Pictures being decoded and scaled: a placeholder each. */
  preparing: Accessor<{ id: string; name: string }[]>;
  error: Accessor<string>;
  focused: Accessor<boolean>;
  composing: Accessor<boolean>;
  /** `/` list rows, `@` list. */
  slash: Accessor<SlashCommand[]>;
  mentions: Accessor<MentionsView | null>;
  peek: Accessor<PeekView | null>;
  /** Which list is open. */
  listed: Accessor<"slash" | "mention" | null>;
  highlighted: Accessor<number>;
  caretBounds: Accessor<Bounds | null>;
  /** The agent's own words for a command's arguments, shown under the box. */
  ghost: Accessor<string | null>;
  running: Accessor<boolean>;
  showStop: Accessor<boolean>;
  guarded: Accessor<boolean>;
  canSend: Accessor<boolean>;
  off: Accessor<string | null>;
  attaching: Signal<boolean>;
  local: Accessor<boolean>;
  cwd: Accessor<string>;
  // events from the input
  onChange(value: string): void;
  onSelection(start: number): void;
  onCaret(bounds: Bounds): void;
  onPaste(e: { text: string; files: { arrayBuffer(): Promise<ArrayBuffer>; name?: string }[]; uris: string[] }): void;
  setInput(ref: InputRef): void;
  setFocused(on: boolean): void;
  setComposing(on: boolean): void;
  // actions
  send(): Promise<void>;
  stop(): Promise<void>;
  pickRow(index: number): void;
  pickMention(index: number, into?: boolean): void;
  descend(index: number): void;
  takeBack(id: number): Promise<void>;
  sendNow(): Promise<void>;
  removeRef(ref: Ref): void;
  removeAttached(path: string): void;
  expandPaste(ref: PasteRef): void;
  addPaths(paths: string[]): Promise<void>;
  dropUris(uris: string[]): void;
  attachFromComputer(): Promise<void>;
  attachFromProject(paths: string[]): void;
  quote(text: string): void;
  /** Mentions a file or folder of the session's machine (absolute path) as if it had been picked with `@`. */
  mentionPath(path: string): void;
  insert(text: string): void;
  focus(): void;
  /** For a test and the screenshots: what the box would send. */
  outgoing(): Outgoing;
}

export function createComposer(props: {
  machine: string;
  id: string;
  port: SessionPort;
  view: () => SessionView;
}): Composer {
  const draftKey = sessionKey(props.machine, props.id);
  const kept = draftOf(draftKey);
  const value = signal(kept?.text ?? "");
  const caret = signal(kept?.text.length ?? 0);
  const selection = signal<{ at: number; seq: number } | null>(null);
  const attached = signal<string[]>(kept?.files ?? []);
  const known = signal<Ref[]>(kept?.refs ?? []);
  const preparing = signal<{ id: string; name: string }[]>([]);
  const error = signal("");
  const focused = signal(false);
  const composing = signal(false);
  const picked = signal(0);
  const hidden = signal(false);
  const guarded = signal(false);
  const attaching = signal(false);
  const caretBounds = signal<Bounds | null>(null);
  const mentions = signal<MentionsView | null>(null);
  const peek = signal<PeekView | null>(null);
  const history = signal<History>(emptyHistory());
  let field: InputRef | undefined;
  let guardTimer: number | undefined;
  let unsentSeq = 0;
  let selSeq = 0;
  let pasteLength = 0;
  /** What GTK inserted for a picture's bytes read as text: taken out again when the edit arrives. */
  let junk = "";
  let ids = 0;
  cleanup(() => clearTimeout(guardTimer));

  const view = props.view;
  const off = () => composerOff(view());
  /** `path` relative to the project when it is inside it, however the project or the path is linked. */
  const inProject = (path: string) => relativeIn(props.machine, cwd(), path, Git.canonicalPath);
  const local = () => Herdr.machines().find((m) => m.id === props.machine)?.local ?? true;
  const cwd = () => view().cwd;
  const original = () => picturesOriginal();
  const running = () => view().running;

  const place = (text: string, at: number) => {
    value.set(text);
    caret.set(at);
    selection.set({ at, seq: ++selSeq });
    error.set("");
    hidden.set(false);
    picked.set(0);
    field?.focus();
    field?.setSelection(at);
  };

  const refsNow = (): Ref[] => known();
  const chips = computed(() => {
    const text = value();
    return activeRefs(text, known())
      .map((ref) => ({ ref, at: spansOf(text, ref)[0]?.start ?? -1 }))
      .sort((a, b) => a.at - b.at)
      .map((c) => c.ref);
  });
  const pictures = computed(() =>
    (chips().filter((r) => r.kind === "picture") as PictureRef[]).sort((a, b) => a.number - b.number),
  );
  const addRef = (ref: Ref) => known.update((all) => [...all.filter((r) => refKey(r) !== refKey(ref)), ref]);

  // ---- the drafts survive a project switch: the words, the files and every chip ----
  effect(() => setDraft(draftKey, { text: value(), files: attached(), refs: known() }));

  // ---- the two lists ----
  const commands = computed<SlashCommand[]>(() =>
    withBuiltIns(
      view().commands.map((c) => ({
        name: c.name,
        description: c.description,
        hint: c.hint ?? undefined,
        source: "builtIn",
        trigger: "/",
        kind: c.kind,
      })),
      view().agent,
      !!view().observed,
    ),
  );
  const slash = computed<SlashCommand[]>(() =>
    hidden() || off() !== null ? [] : byKind(matchCommands(value(), view().agent, commands(), slashMemory())),
  );
  const ghost = (): string | null => hintFor(value(), commands());
  const mention = computed<Mention | null>(() => (focused() && off() === null ? mentionAt(value(), caret()) : null));
  const mentionOpen = () => mention() !== null && !hidden() && (mentions()?.hits.length ?? 0) > 0;
  const listed = (): "slash" | "mention" | null => (slash().length > 0 ? "slash" : mentionOpen() ? "mention" : null);
  const count = () => (listed() === "slash" ? slash().length : (mentions()?.hits.length ?? 0));
  const highlighted = () => Math.max(0, Math.min(picked(), count() - 1));

  // The index is walked when the box first sees `@`, not when the list is first drawn.
  let warmed = false;
  let searching = 0;
  effect(() => {
    const m = mention();
    changedTick();
    if (m === null) {
      untracked(() => {
        searching++;
        peek.set(null);
      });
      return;
    }
    const q = m.query;
    untracked(() => {
      const mine = ++searching;
      if (!warmed) {
        warmed = true;
        warmMentions(props.machine, cwd());
      } else void readChanged(props.machine, cwd());
      // The rows on screen stay until the answer for this query is in: no flash of an empty list between keystrokes.
      searchMentions(props.machine, cwd(), q).then(
        (found) => {
          if (mine !== searching) return;
          mentions.set(found);
          picked.set(0);
          const n = found.hits.length;
          if (n > 0)
            announce(`${found.total} ${found.total === 1 ? "result" : "results"}, ${found.hits[0]!.path}, 1 of ${n}`);
        },
        () => {
          if (mine === searching) mentions.set({ hits: [], total: 0, indexed: 0, truncated: false });
        },
      );
    });
  });

  // What is under the keys: one line about it, asked after a short rest on the row.
  let peekTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(peekTimer));
  effect(() => {
    const hit = listed() === "mention" ? mentions()?.hits[highlighted()] : undefined;
    clearTimeout(peekTimer);
    if (!hit) {
      untracked(() => peek.set(null));
      return;
    }
    untracked(() => {
      peek.set(null);
      peekTimer = setTimeout(() => {
        void Compose.peek(props.machine, cwd(), hit.path, hit.folder).then(
          (p) => {
            const now = mentions()?.hits[highlighted()];
            if (now && now.path === hit.path) peek.set(p);
          },
          () => undefined,
        );
      }, 120);
    });
  });

  // Moving along the list says where the person is, once per move.
  effect(() => {
    const open = listed();
    const i = highlighted();
    if (open !== "mention") return;
    const hit = untracked(() => mentions()?.hits[i]);
    const n = untracked(() => mentions()?.hits.length ?? 0);
    if (hit && i > 0) announce(`${hit.path}${hit.folder ? ", folder" : ""}, ${i + 1} of ${n}`);
  });

  // ---- editing ----
  const exitHistory = () => history.update((h) => (h.at === null ? h : { ...h, at: null }));

  const collapseLongPaste = (prev: string, next: string): string | null => {
    const length = pasteLength;
    pasteLength = 0;
    if (length <= PASTE_COLLAPSE || next.length - prev.length < length) return null;
    // The inserted run is what is new between the old words and the new ones.
    let head = 0;
    while (head < prev.length && prev[head] === next[head]) head++;
    let tail = 0;
    while (tail < prev.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    const inserted = next.slice(head, next.length - tail);
    if (inserted.length < PASTE_COLLAPSE) return null;
    const ref: PasteRef = {
      kind: "paste",
      id: `t${++ids}`,
      number: nextNumber(refsNow(), "paste"),
      text: inserted,
      lines: lineCount(inserted),
    };
    addRef(ref);
    const { text, caret: at } = insertToken(next.slice(0, head) + next.slice(next.length - tail), head, tokenOf(ref));
    caret.set(at);
    selection.set({ at, seq: ++selSeq });
    announce(`Pasted text, ${ref.lines} lines, kept whole`);
    return text;
  };

  const onChange = (typed: string) => {
    const prev = value();
    const next = junk === "" ? typed : typed.split(junk).join("");
    junk = "";
    exitHistory();
    error.set("");
    hidden.set(false);
    picked.set(0);
    const collapsed = collapseLongPaste(prev, next);
    if (collapsed !== null) {
      value.set(collapsed);
      field?.setSelection(caret());
      return;
    }
    const whole = keepAtomic(prev, next, known());
    if (whole) {
      value.set(whole.text);
      caret.set(whole.caret);
      selection.set({ at: whole.caret, seq: ++selSeq });
      field?.setSelection(whole.caret);
      announceGone(prev, whole.text);
      return;
    }
    value.set(next);
    announceGone(prev, next);
  };

  /** A chip that lost its words says so, once. */
  const announceGone = (prev: string, next: string) => {
    const gone = activeRefs(prev, known()).filter((r) => r.kind !== "picture" && spansOf(next, r).length === 0);
    for (const r of gone) announce(`${describe(r)} removed`);
  };

  const describe = (r: Ref): string =>
    r.kind === "mention"
      ? `${r.folder ? "Folder" : "File"} ${r.rel}`
      : r.kind === "picture"
        ? `Image ${r.number}`
        : `Pasted text ${r.number}`;

  // ---- what the lists do when picked ----
  const pickCommand = (command: SlashCommand) => {
    const text = `${command.trigger}${command.name} `;
    place(text, text.length);
  };

  const mentionRefOf = (rel: string, folder: boolean): MentionRef => ({
    kind: "mention",
    path: `${cwd().replace(/\/+$/, "")}/${rel}`,
    rel,
    folder,
  });

  /** Puts a mention in the words at the caret: a chip, and `@path` for an agent that reads only words. */
  const mentionIn = (rel: string, folder: boolean, m?: Mention | null) => {
    const ref = mentionRefOf(rel, folder);
    addRef(ref);
    noteMentioned(props.machine, cwd(), folder ? `${rel}` : rel);
    const text = value();
    if (m) {
      const next = acceptMention(text, m, caret(), tokenOf(ref));
      place(next.text, next.caret);
    } else {
      const next = insertToken(text, caret(), tokenOf(ref));
      place(next.text, next.caret);
    }
    announce(`${describe(ref)} added`);
  };

  const pickMention = (index: number, into = false) => {
    const m = mention();
    const hit = mentions()?.hits[index];
    if (!hit) return;
    if (into && hit.folder) {
      // Right arrow: go into the folder, the list goes on there.
      const text = value();
      const next = `${text.slice(0, m!.start)}@${hit.path}/${text.slice(caret())}`;
      place(next, m!.start + hit.path.length + 2);
      return;
    }
    mentionIn(hit.path, hit.folder, m);
  };

  const pickRow = (index: number) => {
    if (listed() === "slash") pickCommand(slash()[index]!);
    else pickMention(index);
  };

  // Up, Down, Enter, Tab, Right and Escape belong to the open list while the box has the focus; Up and Down also walk what was sent.
  effect(() => {
    const open = listed();
    if (!focused() || composing()) return;
    if (open !== null) {
      const clamp = () => highlighted();
      return keymap.bind(
        {
          down: () => picked.update((i) => (i >= count() - 1 ? 0 : i + 1)),
          up: () => picked.update((i) => (i <= 0 ? count() - 1 : i - 1)),
          enter: () => pickRow(clamp()),
          tab: () => pickRow(clamp()),
          right: () => (open === "mention" ? pickMention(clamp(), true) : undefined),
          escape: () => hidden.set(true),
        },
        { when: "always" },
      );
    }
    const empty = value().trim() === "";
    const walking = history().at !== null;
    if (!empty && !walking) return;
    return keymap.bind(
      {
        up: () => {
          const step = recallUp(history(), value());
          if (!step) return;
          history.set(step.history);
          place(step.text, step.text.length);
        },
        down: () => {
          const step = recallDown(history());
          if (!step) return;
          history.set(step.history);
          place(step.text, step.text.length);
        },
        // Escape on a recalled message gives back what was being typed; it never clears the box.
        escape: () => {
          if (!walking) return;
          const draft = history().draft;
          history.update((h) => ({ ...h, at: null }));
          place(draft, draft.length);
        },
      },
      { when: "always" },
    );
  });

  // `mod+enter` sends when Enter is a new line.
  effect(() => {
    if (!focused() || !enterNewline() || composing()) return;
    return keymap.bind({ "mod+enter": () => void send() }, { when: "always" });
  });

  const showStop = () => running() && !typed();
  const typed = () => sendable(value(), known(), attached());

  // A Stop that just appeared is deaf for a moment, and says so by being dim.
  effect(() => {
    if (!showStop()) return;
    untracked(() => {
      guarded.set(true);
      clearTimeout(guardTimer);
      guardTimer = setTimeout(() => guarded.set(false), 400);
    });
  });

  const stop = async () => {
    try {
      const r = await props.port.cancel();
      if (refused(r)) error.set(r.message);
      else announce("Stopping the turn");
    } catch (e) {
      error.set(reason(e));
    }
  };

  // Escape stops a turn only from the box, and only when no list, recalled message or dialog wants the key.
  effect(() => {
    if (!focused() || !running() || listed() !== null || history().at !== null) return;
    return keymap.bind("escape", () => void stop(), { when: "always" });
  });

  // ---- sending ----
  const send = async () => {
    if (off() !== null || !typed() || composing() || savingPictures) return;
    // An agent that cannot see takes its pictures as files, as herdr-mobile does: saved into the project and named by path
    // in the words, with nothing to read or press first.
    if (blind() && !(await picturesAsFiles())) return;
    const raw = value();
    const refs = refsNow();
    const carried = attached();
    const words = outgoing(raw, refs, carried);
    const out = view().observed ? forTerminal(words, carried) : words;
    const sentIds = new Set(activeRefs(raw, refs).map(refKey));
    const sentPictures =
      out.pictures.length > 0 ? refs.filter((r) => r.kind === "picture" && sentIds.has(refKey(r))) : [];
    // The thumbnails leave with the words: a second Enter during the wait must not send them again.
    known.update((all) => all.filter((r) => !sentPictures.includes(r)));
    value.set("");
    caret.set(0);
    attached.set([]);
    error.set("");
    try {
      const r = await props.port.send(out.text, out.files, out.pictures);
      if (refused(r)) {
        value.update((now) => restoreText(now, raw));
        attached.update((now) => [...new Set([...carried, ...now])]);
        sentPictures.forEach(addRef);
        error.set(`${(r.message || "Not sent").replace(/\.+$/, "")}. Your message is still in the box.`);
        announce("Message not sent");
        return;
      }
      for (const m of activeRefs(raw, refs)) if (m.kind === "mention") noteMentioned(props.machine, cwd(), m.rel);
      history.set(remember(history(), plainText(raw, refs)));
      noteSent(out.text, view().agent, commands());
      // What went is forgotten; what was added meanwhile stays.
      known.update((all) => all.filter((r) => !sentIds.has(refKey(r))));
      if (value().trim() === "") known.update((all) => all.filter((r) => r.kind === "picture"));
      if (r.kind === "queued") announce("Queued. It is sent when the turn ends");
    } catch (e) {
      value.update((now) => restoreText(now, raw));
      attached.update((now) => [...new Set([...carried, ...now])]);
      sentPictures.forEach(addRef);
      error.set(`Could not send: ${reason(e)}. Your message is still in the box.`);
      announce("Message not sent");
    }
  };

  // ---- a message that comes back: refused by the agent, or taken back from the queue ----
  const restore = (text: string, files: string[], pictures: { path: string; name: string; number: number }[]) => {
    value.update((now) => restoreText(now, text));
    for (const path of files) {
      const rel = inProject(path);
      const folder = rel !== null && value().includes(`${rel}/`);
      const ref = rel === null ? null : mentionRefOf(rel, folder);
      if (ref && spansOf(value(), ref).length > 0) addRef(ref);
      else attached.update((all) => [...new Set([...all, path])]);
    }
    for (const p of pictures) {
      void Compose.preparePaths([p.path], original()).then((done) => {
        const view = done[0]?.picture;
        if (view) addRef(pictureRef(view, p.name, p.number));
      });
    }
  };

  effect(() => {
    const unsent = view().unsent;
    if (!unsent || unsent.seq === unsentSeq) return;
    unsentSeq = unsent.seq;
    untracked(() => {
      restore(unsent.text, unsent.files, unsent.pictures);
      error.set("The agent did not take the message. It is back in the box.");
      announce("The agent did not take the message. It is back in the box");
    });
  });

  const takeBack = async (id: number) => {
    try {
      const taken = await props.port.unqueue(id);
      if (!taken) {
        notify("Already sent");
        return;
      }
      restore(taken.text, taken.files, taken.pictures);
      field?.focus();
      announce("Moved back to the message box");
    } catch (e) {
      notify(reason(e), { type: "error" });
    }
  };

  const sendNow = async () => {
    try {
      const r = await props.port.releaseQueue();
      if (refused(r)) notify(r.message || "Could not send the queue", { type: "error" });
    } catch (e) {
      notify(reason(e), { type: "error" });
    }
  };

  // ---- pictures, files, drops ----
  const pictureRef = (v: PictureView, name: string, number?: number): PictureRef => ({
    kind: "picture",
    id: `i${++ids}`,
    number: number ?? nextNumber(refsNow(), "picture"),
    path: v.path,
    name,
    mime: v.mime,
    width: v.width,
    height: v.height,
    bytes: v.bytes,
    scaled: v.scaled,
    thumb: v.thumb,
  });

  const limits = () => Compose.limits();
  const room = () => limits().maxPictures - pictures().length - preparing().length;

  /** One picture is ready: a thumbnail above the box and nothing in the words. */
  const taken = (v: PictureView, name: string) => {
    const ref = pictureRef(v, name);
    addRef(ref);
    const n = pictures().length;
    announce(`Image ${ref.number} added. ${n} ${n === 1 ? "picture" : "pictures"} in the message`);
  };

  const refuse = (message: string) => {
    error.set(message);
    announce(message);
  };

  const withPending = async (name: string, work: () => Promise<void>) => {
    const id = `w${++ids}`;
    preparing.update((all) => [...all, { id, name }]);
    try {
      await work();
    } catch (e) {
      refuse(`Could not add ${name}: ${reason(e)}`);
    } finally {
      preparing.update((all) => all.filter((p) => p.id !== id));
    }
  };

  const addBytes = async (file: { arrayBuffer(): Promise<ArrayBuffer>; name?: string }, index: number) => {
    if (room() <= 0) return refuse(`At most ${limits().maxPictures} pictures go with one message`);
    const name =
      file.name && file.name !== "" ? file.name : `Pasted image ${nextNumber(refsNow(), "picture") + index}.png`;
    await withPending(name, async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      taken(await Compose.preparePicture(bytes, original()), name);
    });
  };

  const attachLocal = (path: string) => {
    const rel = local() ? inProject(path) : null;
    if (rel !== null) {
      // A file of the project is mentioned: its words and its chip say where it is.
      if (!activeRefs(value(), known()).some((r) => r.kind === "mention" && r.rel === rel)) mentionIn(rel, false);
      return;
    }
    if (activeFiles() >= MAX_FILES) return refuse(`At most ${MAX_FILES} files go with one message`);
    attached.update((all) => (all.includes(path) ? all : [...all, path]));
    announce(`${path.split("/").pop()} attached`);
  };

  const activeFiles = () => attached().length + chips().filter((r) => r.kind === "mention").length;

  /** Paths of this computer (a drop, a pasted file list, the system dialog): pictures become chips, files are attached. */
  const addPaths = async (paths: string[]) => {
    if (off() !== null || paths.length === 0) return;
    const sorted: DroppedView[] = await Compose.preparePaths(paths, original());
    const files = sorted.filter((d) => d.kind === "file" || d.kind === "folder");
    for (const d of sorted) {
      if (d.kind === "failed") refuse(d.message ?? `Could not add ${d.name}`);
      else if (d.kind === "picture" && d.picture) {
        if (room() <= 0) refuse(`At most ${limits().maxPictures} pictures go with one message`);
        else taken(d.picture, d.name);
      }
    }
    if (files.length === 0) return;
    if (local()) {
      for (const f of files) attachLocal(f.path);
      return;
    }
    // Another machine's agent reads paths on its own machine: a file of this computer is sent there first.
    const only = files.filter((f) => f.kind === "file").map((f) => f.path);
    if (only.length === 0) return refuse("A folder of this computer cannot be sent to another machine");
    sending.set({ machine: props.machine, folder: cwd(), paths: only });
    notify("Send them to the machine, then attach them from the project");
  };

  const dropUris = (uris: string[]) => {
    const paths = uris.map((u) => Files.pathFromUri(u)).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return refuse("Only files from this computer can be attached by dropping");
    void addPaths(paths);
  };

  const attachFromComputer = async () => {
    if (off() !== null) return;
    try {
      await addPaths(await Compose.pickFiles());
    } catch {
      // No system dialog here (a Linux without a file chooser): the project's own list does the job.
      attaching.set(true);
    }
    field?.focus();
  };

  const attachFromProject = (paths: string[]) => {
    for (const p of paths) {
      const rel = inProject(p);
      if (rel !== null) {
        if (!activeRefs(value(), known()).some((r) => r.kind === "mention" && r.rel === rel)) mentionIn(rel, false);
      } else attached.update((all) => (all.includes(p) ? all : [...all, p]));
    }
    field?.focus();
  };

  const onPaste: Composer["onPaste"] = (e) => {
    // Text wins a mixed clipboard (a spreadsheet cell is text and a picture of it), unless the "text" is the picture's bytes.
    if (e.text !== "" && !(e.files.length > 0 && looksBinary(e.text))) {
      pasteLength = e.text.length;
      return;
    }
    junk = e.text;
    if (e.uris.length > 0) {
      dropUris(e.uris);
      return;
    }
    e.files.forEach((file, i) => void addBytes(file, i));
  };

  const removeRef = (ref: Ref) => {
    value.update((text) => withoutRef(text, ref));
    if (ref.kind === "picture") known.update((all) => all.filter((r) => r !== ref));
    caret.update((c) => Math.min(c, value().length));
    announce(`${describe(ref)} removed. ${activeRefs(value(), known()).length} left`);
    field?.focus();
  };

  const removeAttached = (path: string) => {
    attached.update((all) => all.filter((p) => p !== path));
    announce(`${path.split("/").pop()} removed`);
  };

  const expandPaste = (ref: PasteRef) => {
    const text = value();
    const at = spansOf(text, ref)[0];
    if (!at) return;
    const next = text.slice(0, at.start) + ref.text + text.slice(at.end);
    place(next, at.start + ref.text.length);
  };

  // ---- an agent that cannot see: the picture goes into the project and is mentioned by path ----
  const blind = computed(() => off() === null && !view().acceptsPictures && pictures().length > 0);

  let savingPictures = false;
  /** Saves every picture in the box into the project and puts its path in the words; false when one could not be saved. */
  const picturesAsFiles = async (): Promise<boolean> => {
    savingPictures = true;
    let text = value();
    try {
      for (const p of pictures()) {
        const saved = await Compose.saveToProject(props.machine, cwd(), p.path, p.name);
        const rel = inProject(saved.path) ?? saved.path;
        const ref = mentionRefOf(rel, false);
        ref.path = saved.path;
        addRef(ref);
        known.update((all) => all.filter((r) => r !== p));
        text = insertToken(text, text.length, tokenOf(ref)).text;
      }
      place(text, text.length);
      return true;
    } catch (e) {
      refuse(`Could not send the picture: ${reason(e)}`);
      return false;
    } finally {
      savingPictures = false;
    }
  };

  const quote = (selected: string) => {
    const body = selected
      .replace(/\s+$/, "")
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const text = value();
    const lead = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const next = `${text}${lead}${body}\n\n`;
    place(next, next.length);
    announce("Quoted in the message box");
  };

  const mentionPath = (path: string) => {
    if (off() !== null) return;
    const rel = inProject(path);
    if (rel === null) {
      attached.update((all) => (all.includes(path) ? all : [...all, path]));
      announce(`${path.split("/").pop()} attached`);
      return;
    }
    if (!activeRefs(value(), known()).some((r) => r.kind === "mention" && r.rel === rel)) mentionIn(rel, false);
    field?.focus();
  };

  const insert = (text: string) => place(value() + text, (value() + text).length);

  return {
    value,
    selection,
    attached,
    chips,
    pictures,
    preparing,
    error,
    focused,
    composing,
    slash,
    mentions: () => (mention() ? mentions() : null),
    peek,
    listed,
    highlighted,
    caretBounds,
    ghost,
    running,
    showStop,
    guarded,
    canSend: () => off() === null && (typed() || showStop()),
    off,
    attaching,
    local,
    cwd,
    onChange,
    onSelection: (start) => caret.set(start),
    onCaret: (bounds) => caretBounds.set(bounds),
    onPaste,
    setInput: (ref) => {
      field = ref;
    },
    setFocused: (on) => focused.set(on),
    setComposing: (on) => composing.set(on),
    send,
    stop,
    pickRow,
    pickMention,
    descend: (i) => pickMention(i, true),
    takeBack,
    sendNow,
    removeRef,
    removeAttached,
    expandPaste,
    addPaths,
    dropUris,
    attachFromComputer,
    attachFromProject,
    quote,
    mentionPath,
    insert,
    focus: () => field?.focus(),
    outgoing: () => outgoing(value(), known(), attached()),
  };
}
