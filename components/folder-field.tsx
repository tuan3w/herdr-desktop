import { Files } from "herdr-desktop/native";
import { announce, computed, effect, keymap, signal, untracked } from "nsh";

import type { Suggestion } from "#kit";
import { Autocomplete } from "#kit";
import { type FolderEntry, complete, isMissing, parents, suggest } from "#lib/folder-suggest";
import { board } from "#lib/herdr";
import { projectFolder } from "#lib/sidebar";

/** The rows the list shows before it scrolls: ten 32-pt rows, and half of the next peeks (`listHeight`) to say there are more. */
const ROWS = 10;
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The folder of a machine as a path field that suggests: while typing, the subfolders of the nearest folder that exists
 * whose names match what follows it; empty, the machine's projects and recent folders. `Tab` (or Enter on a highlighted
 * row) completes a folder into the field with a `/` so the next level lists; Enter with nothing highlighted is the
 * form's, Escape closes the list and only then the dialog. The listing is `Files.list` (Rust, remote machines through
 * their own link), asked for one folder at a time and kept while the dialog is open; a failure is one muted line in the
 * list and the field is never touched. It replaces the folder-picker dialog: a chooser is the field's own list, never a
 * second dialog (`design/file-picker.md`).
 */
export function FolderField(props: {
  label: string;
  machine: string;
  value: string;
  onChange: (value: string) => void;
  /** Folders used lately, offered after the machine's projects while the field is empty. */
  recents: readonly string[];
  /** The dialog the field is in is open: an empty field then opens its list at once. */
  active: boolean;
  autoFocus?: boolean;
  required?: boolean;
  reserve?: boolean;
  placeholder?: string;
  error?: string;
  hint?: string;
  onSubmit?: () => void;
  onBlur?: () => void;
}) {
  const listed = signal<{ machine: string; shown: string; entries: FolderEntry[] } | undefined>(undefined);
  const failure = signal<string | undefined>(undefined);
  const pending = signal(false);
  const open = signal(false);
  const lit = signal<string | undefined>(undefined);
  /** Answers by machine and folder (`null`: not there); a folder created meanwhile shows when the dialog opens again. */
  const cache = new Map<string, FolderEntry[] | null>();
  let latest = 0;
  let keep = false;

  effect(() => {
    if (!props.active) return;
    untracked(() => {
      cache.clear();
      listed.set(undefined);
      // The form sets the field in its own opening effect: look once that has run.
      setTimeout(() => {
        if (props.value === "" && props.autoFocus) open.set(true);
      }, 0);
    });
  });

  /** Finds the nearest folder of `typed` that exists, from the cache first so a keystroke inside a known folder asks nothing. */
  async function resolve(machine: string, typed: string, mine: number) {
    const candidates = parents(typed);
    failure.set(undefined);
    pending.set(false);
    for (const c of candidates) {
      const key = `${machine}\0${c.dir}`;
      let entries = cache.get(key);
      if (entries === undefined) {
        pending.set(true);
        try {
          const view = await Files.list(machine, c.dir);
          entries = view.entries.map((e) => ({ name: e.name, kind: e.kind, readable: e.readable }));
        } catch (e) {
          if (mine !== latest) return;
          if (!isMissing(reason(e))) {
            pending.set(false);
            failure.set(`Couldn't list ${c.shown}: ${reason(e)}`);
            announce(`Couldn't list ${c.shown}`);
            return;
          }
          entries = null;
        }
        if (mine !== latest) return;
        cache.set(key, entries);
      }
      if (entries === null) continue;
      pending.set(false);
      listed.set({ machine, shown: c.shown, entries });
      return;
    }
    pending.set(false);
    listed.set(undefined);
  }

  effect(() => {
    if (!props.active) return;
    const machine = props.machine;
    const typed = props.value;
    untracked(() => void resolve(machine, typed, ++latest));
  });

  /** The folders of the projects the board knows on the machine: what most people choose from. */
  const projects = computed(() =>
    board()
      .projects.filter((p) => p.machine === props.machine)
      .map(projectFolder)
      .filter((f) => f !== ""),
  );
  const result = computed(() => {
    const here = listed();
    const nearest = parents(props.value)[0]?.shown;
    // Rows of a folder further up wait for the nearer folder's answer: they would name folders the person has passed.
    const fits = here && here.machine === props.machine && (!pending() || here.shown === nearest);
    return suggest({
      typed: props.value,
      listed: fits ? here : undefined,
      projects: projects(),
      recents: props.recents,
    });
  });
  const suggestions = computed<Suggestion[]>(() =>
    result().rows.map((r) => ({
      text: complete(r),
      title: r.name,
      hint: r.hint,
      group: r.group,
      disabled: r.unreadable,
    })),
  );
  /** The one line under nothing: why there are no rows, or a blank row while the answer is on its way (no spinner). */
  const empty = (): string | undefined => {
    if (props.value.trim() === "") return undefined;
    if (failure()) return failure();
    if (pending() || (parents(props.value).length > 0 && listed() === undefined)) return " ";
    return result().note;
  };

  // Typing moves the highlight to nothing: Tab then completes the first row, as a shell does.
  effect(() => {
    void props.value;
    untracked(() => lit.set(undefined));
  });
  const completable = computed(() => open() && suggestions().some((s) => !s.disabled));
  effect(() => {
    if (!completable()) return;
    return keymap.bind(
      {
        tab: () => {
          const row = suggestions().find((s) => s.text === lit()) ?? suggestions().find((s) => !s.disabled);
          if (row) props.onChange(row.text);
        },
      },
      { when: "always" },
    );
  });

  return (
    <Autocomplete
      label={props.label}
      autoFocus={props.autoFocus}
      required={props.required}
      reserve={props.reserve}
      mono
      placeholder={props.placeholder}
      value={props.value}
      onChange={props.onChange}
      suggestions={suggestions()}
      filter={() => true}
      rows={ROWS}
      empty={empty()}
      open={open()}
      openOnInputClick
      onOpenChange={(next, change) => {
        // Completing a folder keeps the list for the folder's own folders.
        if (!next && change.reason === "item-press" && keep) change.cancel();
        else open.set(next);
      }}
      onPick={(s) => {
        keep = s.text.endsWith("/");
      }}
      onItemHighlighted={(s) => lit.set(s?.text)}
      onSubmit={props.onSubmit}
      onBlur={props.onBlur}
      error={props.error}
      hint={props.hint}
    />
  );
}
