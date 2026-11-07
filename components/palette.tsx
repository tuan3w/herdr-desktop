import { Files, Search } from "herdr-desktop/native";
import { announce, computed, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Command, type CommandItem, type CommandRef } from "nsh/base";

import type { FileSearch, SearchFocus } from "herdr-desktop/native";

import { ArgChips, ScopeChips } from "#components/palette-chips";
import { Row } from "#components/palette-row";
import { Clipped, Kbd, PaletteDialog, Spinner } from "#kit";
import { viewFile } from "#lib/files";
import { projectOf } from "#lib/herdr";
import type { AgentChoice } from "#lib/new-session";
import { paletteCommands, type PaletteCommand } from "#lib/palette/commands";
import { filesRoot, paletteFocus } from "#lib/palette/context";
import { palette, paletteHandle, paletteStart } from "#lib/palette/controller";
import { actionsFor, fileActions, type HitAction } from "#lib/palette/hit-actions";
import { openResult, type OpenHow, previewOf } from "#lib/palette/open";
import { rowOfHit, type PaletteRow } from "#lib/palette/rows";
import { readQuery, scopeInfo, SCOPES, stepScope, type PaletteScope } from "#lib/palette/scopes";
import { agentKindsOn, phraseOf, runWith } from "#lib/palette/steps";
import { timing } from "#lib/perf";
import { keyText } from "#lib/shortcuts";
import { projectFolder } from "#lib/sidebar";
import { fold } from "#lib/text";

/**
 * The command palette: one search over everything the person can go to or do, in a card at the top of the window.
 * `mod+k` and `mod+shift+p` open it, `mod+p` opens it on the files of the project, `mod+e` is the Switcher. Design and
 * rules: `design/palette.md`.
 *
 * Three layers share the one list: the results (what the query finds, or on an empty query what needs you and what was
 * visited), the actions of the highlighted result (`mod+k` again, or Right on an empty query), and a command's steps
 * (`New agent session in…` then a project then an agent). Escape steps back one layer, then clears the query, then closes.
 * The ranking is Rust (`Search`), frozen when the palette opens: rows never move while it is open, only what a row says
 * about itself (its shape, its age) changes in place.
 */
type Mode =
  | { kind: "results" }
  | { kind: "actions"; row: PaletteRow }
  | { kind: "step"; command: PaletteCommand; chosen: { value: string; label: string }[] };

/** Keystrokes to rows committed, p95: the budget `docs/PERFORMANCE.md` holds this palette to (16 ms). */
const typing = timing("palette typing", "Palette keystroke to rows", { warn: 16, bad: 32 });
const opening = timing("palette open", "Palette open (index)", { warn: 50, bad: 100 });

/**
 * Rows a query lists: what is mounted is what is listed, so the list stops at 30 and says how many more there are. The
 * keystroke that matters is the one that narrows them.
 */
const PAGE = 30;

const PROMPTS = { project: "Choose a project", agentKind: "Choose an agent", file: "Choose a file" } as const;

export function Palette(props: { open: boolean; onClose: () => void }) {
  const scope = signal<PaletteScope>("all");
  const text = signal("");
  const mode = signal<Mode>({ kind: "results" });
  const session = signal<number | null>(null);
  const highlighted = signal<string | null>(null);
  const found = signal<FileSearch | null>(null);
  const searching = signal(false);
  const kinds = signal<AgentChoice[] | null>(null);
  const kindsError = signal("");
  let command: CommandRef | undefined;
  let commandList: PaletteCommand[] = [];
  let commandMap: ReadonlyMap<string, PaletteCommand> = new Map();
  // Where it was opened from; the project's folder is read from the board as it is NOW, so a board that arrives or changes
  // after the palette opened (the first moments of the app, a folder herdr reports late) is searched at its new folder.
  const focusAt = signal<SearchFocus>({});
  const filesAt = computed(() => filesRoot(focusAt()));
  let sequence = 0;
  let opened = false;
  let warmedRoot = "";

  // ---- opening and closing ----

  const begin = (start: { scope: PaletteScope; text: string }) => {
    commandList = paletteCommands();
    commandMap = new Map(commandList.map((c) => [c.spec.id, c]));
    const focus = paletteFocus();
    focusAt.set(focus);
    try {
      session.set(
        Search.open(
          commandList.map((c) => c.spec),
          focus,
        ),
      );
    } catch {
      // No engine (a lab without one): the palette lists nothing, and still opens and closes.
      session.set(null);
    }
    mode.set({ kind: "results" });
    scope.set(start.scope);
    text.set(start.text);
    highlighted.set(null);
    found.set(null);
    kinds.set(null);
    warmedRoot = "";
    announce("Command palette");
  };

  const end = () => {
    const s = session();
    if (s !== null) Search.close(s);
    session.set(null);
    sequence++;
    opened = false;
  };

  effect(() => {
    const start = paletteStart();
    if (!props.open) {
      untracked(() => {
        if (opened) end();
      });
      return;
    }
    untracked(() => {
      if (!opened) {
        opened = true;
        opening.time(() => begin(start));
      } else {
        // Asked again while open (`mod+p`): move to that scope, keep the session.
        mode.set({ kind: "results" });
        scope.set(start.scope);
        text.set(start.text);
      }
    });
  });

  // ---- what is listed ----

  const helpMode = computed(() => scope() === "all" && mode().kind === "results" && text().startsWith("?"));

  /** The ranked results of the typed query; `null` where Rust is not asked (files, help, another layer). */
  const page = computed(() => {
    const s = session();
    if (s === null || mode().kind !== "results" || scope() === "files" || helpMode()) return null;
    const started = performance.now();
    const answer = Search.query(s, { query: text(), scope: scope() as never, limit: PAGE });
    typing.record(performance.now() - started);
    return answer;
  });

  const projects = computed(() => {
    const s = session();
    const m = mode();
    if (s === null || m.kind !== "step" || m.command.args?.[m.chosen.length] !== "project") return null;
    return Search.query(s, { query: text(), scope: "projects", limit: PAGE });
  });

  const fileRows = (choose?: (row: PaletteRow) => void): PaletteRow[] => {
    const result = found();
    const at = filesAt();
    if (!result || !at) return [];
    return result.hits.map((h) => {
      const path = `${at.root}/${h.path}`;
      const nameFrom = h.path.length - h.name.length;
      // The match covers the whole path; the name carries the letters, the muted folder after it is left plain.
      const marks: number[] = [];
      for (let i = 0; i + 1 < h.marks.length; i += 2) {
        const [from, to] = [Math.max(h.marks[i], nameFrom), h.marks[i + 1]];
        if (to > from) marks.push(from - nameFrom, to - nameFrom);
      }
      const row: PaletteRow = {
        id: `file:${h.path}`,
        kind: "file",
        title: h.name,
        marks,
        parts: [h.dir === "" ? "project root" : h.dir, ...(h.ignored ? ["ignored by git"] : [])],
        glyph: "file",
        age: "",
        checked: false,
        waiting: false,
        spoken: `${h.name}, in ${h.dir === "" ? "the project root" : h.dir}${h.ignored ? ", ignored by git" : ""}`,
        file: { machine: at.machine, path, root: at.root },
      };
      return choose ? { ...row, choose: () => choose(row) } : row;
    });
  };

  const helpRows = (): PaletteRow[] =>
    SCOPES.filter((s) => s.prefix !== undefined).map((s) => ({
      id: `help:${s.id}`,
      kind: "help",
      title: s.label,
      marks: [],
      parts: [s.finds],
      glyph: "search",
      age: "",
      keys: s.prefix,
      checked: false,
      waiting: false,
      spoken: `${s.label}: ${s.finds}. Type ${s.prefix} to search it`,
      choose: () => {
        scope.set(s.id);
        text.set("");
      },
    }));

  const synthetic = (
    id: string,
    title: string,
    parts: string[],
    icon: PaletteRow["glyph"],
    choose: () => void,
  ): PaletteRow => ({
    id,
    kind: "action",
    title,
    marks: [],
    parts,
    glyph: icon,
    age: "",
    checked: false,
    waiting: false,
    spoken: [title, ...parts].join(", "),
    choose,
  });

  /** Nothing matched: say so and offer the next steps, as rows the keyboard reaches. */
  const noResultRows = (): PaletteRow[] => {
    const q = text().trim();
    const group = `No match for “${q}”`;
    const rows: PaletteRow[] = [];
    if (scope() !== "messages")
      rows.push(
        synthetic("next:messages", `Search messages for “${q}”`, ["Titles and recent output"], "message", () =>
          scope.set("messages"),
        ),
      );
    if (filesAt() && scope() !== "files")
      rows.push(
        synthetic("next:files", `Search files for “${q}”`, [filesAt()?.project ?? ""], "file", () =>
          scope.set("files"),
        ),
      );
    const start = commandMap.get("newSessionIn");
    if (start)
      rows.push(
        synthetic("next:session", "New agent session…", ["Pick a project and an agent"], "plus", () =>
          enterStep(start),
        ),
      );
    if (/^(~|\/|\.\/)/.test(q))
      rows.push(
        synthetic("next:path", `Open “${q}”`, ["As a path on this computer"], "file", () => {
          props.onClose();
          viewFile(filesAt()?.machine ?? "local", q);
        }),
      );
    return rows.map((r) => ({ ...r, group }));
  };

  const actionList = (row: PaletteRow): HitAction[] =>
    row.file ? fileActions(row.file.machine, row.file.path, row.file.root) : actionsFor(row, commandMap);

  const actionRows = (row: PaletteRow): PaletteRow[] => {
    const q = fold(text()).trim();
    return actionList(row)
      .filter((a) => q === "" || fold(a.label).includes(q))
      .map((a) => ({
        ...synthetic(`action:${a.id}`, a.label, a.asks ? [`asks first: ${a.asks}`] : [], "arrow-right", () => {
          props.onClose();
          void a.run();
        }),
        keys: a.keys,
        disabled: a.disabled,
        spoken: [
          a.label,
          a.keys ? `key ${a.keys}` : "",
          a.asks ? `asks first, ${a.asks}` : "",
          a.disabled ? `unavailable, ${a.disabled}` : "",
        ]
          .filter(Boolean)
          .join(", "),
      }));
  };

  const stepRows = (m: Extract<Mode, { kind: "step" }>): PaletteRow[] => {
    const which = m.command.args?.[m.chosen.length];
    if (which === "project")
      return (projects()?.hits ?? []).map((h) => ({
        ...rowOfHit(h, commandMap),
        group: undefined,
        choose: () => pick(m, h.target, h.title),
      }));
    if (which === "agentKind") {
      const project = projectOf(m.chosen[0]?.value ?? "");
      const q = fold(text()).trim();
      return (kinds() ?? [])
        .filter((k) => q === "" || fold(k.label).includes(q))
        .map((k) => ({
          ...synthetic(`kind:${k.id}`, k.label, [`on ${project?.machineName ?? "the machine"}`], "bot", () =>
            pick(m, k.id, k.label),
          ),
          disabled: k.installed
            ? undefined
            : `${k.label} is not installed on ${project?.machineName ?? "that machine"}`,
        }));
    }
    return fileRows((row) => pick(m, `${row.file?.machine}\n${row.file?.path}`, row.title));
  };

  /** What the list says after its last row when the query matches more than it shows: a row that cannot be chosen. */
  const moreRow = (n: number): PaletteRow => ({
    ...synthetic("more", `${n} more`, ["keep typing to narrow them"], "chevron-down", () => undefined),
    disabled: "keep typing to narrow them",
    group: undefined,
  });

  const rows = computed<PaletteRow[]>(() => {
    const m = mode();
    if (m.kind === "actions") return actionRows(m.row);
    if (m.kind === "step") return stepRows(m);
    if (helpMode()) return helpRows();
    if (scope() === "files") return fileRows();
    const p = page();
    if (!p) return [];
    if (p.hits.length === 0 && text().trim() !== "") return noResultRows();
    const found = p.hits.map((h) => rowOfHit(h, commandMap));
    const rest = p.total - p.hits.length;
    return rest > 0 ? [...found, moreRow(rest)] : found;
  });

  const byId = computed(() => new Map(rows().map((r) => [r.id, r])));
  // A row that cannot run is dimmed and passed over by the keys; the reason is written in the row itself.
  const items = computed<CommandItem[]>(() =>
    rows().map((r) => ({ id: r.id, label: r.spoken, group: r.group, disabled: r.disabled !== undefined })),
  );
  const current = () => (highlighted() === null ? undefined : byId().get(highlighted() ?? ""));

  // ---- files, which are asked of Rust while typing and may arrive late ----

  effect(() => {
    const m = mode();
    const wants =
      props.open && (scope() === "files" || (m.kind === "step" && m.command.args?.[m.chosen.length] === "file"));
    const q = text();
    const at = filesAt();
    if (!wants) return;
    untracked(() => {
      if (!at) {
        found.set(null);
        return;
      }
      if (warmedRoot !== `${at.machine}:${at.root}`) {
        warmedRoot = `${at.machine}:${at.root}`;
        void Files.warm(at.machine, at.root).catch(() => undefined);
      }
      const mine = ++sequence;
      searching.set(true);
      Files.search(at.machine, at.root, q, PAGE).then(
        (answer) => {
          // A late answer to an older query is dropped: what is shown is what is typed.
          if (mine !== sequence) return;
          found.set(answer);
          searching.set(false);
        },
        () => {
          if (mine !== sequence) return;
          found.set(null);
          searching.set(false);
        },
      );
    });
  });

  // The agents a machine can start, asked when that step opens: a round trip to the machine.
  effect(() => {
    const m = mode();
    if (m.kind !== "step" || m.command.args?.[m.chosen.length] !== "agentKind") return;
    const machine = projectOf(m.chosen[0]?.value ?? "")?.machine;
    untracked(() => {
      kinds.set(null);
      kindsError.set("");
      if (machine === undefined) return;
      const mine = ++sequence;
      searching.set(true);
      agentKindsOn(machine).then(
        (list) => {
          if (mine !== sequence) return;
          kinds.set(list);
          searching.set(false);
        },
        (e) => {
          if (mine !== sequence) return;
          kinds.set([]);
          kindsError.set(e instanceof Error ? e.message : String(e));
          searching.set(false);
        },
      );
    });
  });

  // ---- moving between layers ----

  const enterStep = (c: PaletteCommand, rest = "") => {
    mode.set({ kind: "step", command: c, chosen: [] });
    text.set(rest);
    announce(`${c.spec.label.replace(/…$/, "")}. ${PROMPTS[c.args?.[0] ?? "project"]}`);
  };

  const pick = (m: Extract<Mode, { kind: "step" }>, value: string, label: string) => {
    const chosen = [...m.chosen, { value, label }];
    const args = m.command.args ?? [];
    if (chosen.length < args.length) {
      mode.set({ ...m, chosen });
      text.set("");
      announce(PROMPTS[args[chosen.length]]);
      return;
    }
    props.onClose();
    void runWith(
      m.command,
      chosen.map((c) => c.value),
    );
  };

  /** One layer back: the action panel or a step, then the scope. Returns false when there was none (the next Escape closes). */
  const back = (): boolean => {
    const m = mode();
    if (m.kind === "actions") {
      const row = m.row;
      mode.set({ kind: "results" });
      text.set("");
      setTimeout(() => command?.highlight(row.id), 0);
      return true;
    }
    if (m.kind === "step") {
      mode.set(m.chosen.length > 0 ? { ...m, chosen: m.chosen.slice(0, -1) } : { kind: "results" });
      text.set("");
      return true;
    }
    if (scope() !== "all") {
      scope.set("all");
      return true;
    }
    return false;
  };

  const toggleActions = () => {
    const m = mode();
    if (m.kind === "actions") {
      back();
      return;
    }
    const row = current();
    if (m.kind !== "results" || !row || row.kind === "help" || row.kind === "action") {
      announce("No actions here");
      return;
    }
    mode.set({ kind: "actions", row });
    text.set("");
    announce(`Actions for ${row.title}`);
  };

  const choose = (id: string, how: OpenHow = "default") => {
    const row = byId().get(id);
    if (!row) return;
    if (row.disabled) {
      announce(row.disabled);
      return;
    }
    if (row.choose) {
      row.choose();
      return;
    }
    const spec = row.hit ? commandMap.get(row.hit.target) : undefined;
    if (spec?.args && how === "default") {
      enterStep(spec);
      return;
    }
    props.onClose();
    void openResult(row, commandMap, how);
  };

  effect(() => {
    if (!props.open) return;
    paletteHandle.toggleActions = toggleActions;
    const unbind = keymap.bind(
      {
        tab: () => mode().kind === "results" && scope.set(stepScope(scope(), 1)),
        "shift+tab": () => mode().kind === "results" && scope.set(stepScope(scope(), -1)),
        "shift+enter": () => highlighted() !== null && choose(highlighted() ?? "", "side"),
        "mod+enter": () => highlighted() !== null && choose(highlighted() ?? "", "view"),
      },
      { when: "always" },
    );
    return () => {
      unbind();
      paletteHandle.toggleActions = undefined;
    };
  });

  // Inside a layer (the actions, a command's steps) Backspace on an empty field takes the last chip off. A bound key is
  // consumed, so while a layer is open the palette deletes the character itself (at the end of the filter, which is
  // where a short filter is edited); on the results Backspace stays the field's, with its caret and its words.
  effect(() => {
    if (!props.open || mode().kind === "results") return;
    return keymap.bind(
      {
        backspace: () => (text() === "" ? back() : text.set(text().slice(0, -1))),
      },
      { when: "always", repeat: true },
    );
  });

  // The number of results, said once the typing pauses: the highlighted row is announced on its own at every key.
  let pause: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    if (!props.open) return;
    const [q, s, m, searchingNow] = [text(), scope(), mode(), searching()];
    clearTimeout(pause);
    if (searchingNow || (q.trim() === "" && s === "all" && m.kind === "results")) return;
    pause = setTimeout(() => {
      const n = untracked(() => rows().length);
      announce(n === 0 ? "No results" : n === 1 ? "1 result" : `${n} results`);
    }, 400);
  });

  // ---- what the search bar says ----

  const chips = computed<string[]>(() => {
    const m = mode();
    if (m.kind === "actions") return ["Actions", m.row.title];
    if (m.kind === "step") return [m.command.spec.label.replace(/…$/, ""), ...m.chosen.map((c) => c.label)];
    return [];
  });

  const placeholder = computed(() => {
    const m = mode();
    if (m.kind === "actions") return "Filter the actions";
    if (m.kind === "step") return PROMPTS[m.command.args?.[m.chosen.length] ?? "project"];
    return scopeInfo(scope()).placeholder;
  });

  const label = computed(() => {
    const m = mode();
    if (m.kind === "actions") return `Actions for ${m.row.title}`;
    if (m.kind === "step") return PROMPTS[m.command.args?.[m.chosen.length] ?? "project"];
    return scopeInfo(scope()).placeholder;
  });

  const emptyText = computed(() => {
    const m = mode();
    if (m.kind === "step" && m.command.args?.[m.chosen.length] === "agentKind")
      return kindsError() !== ""
        ? `Could not ask the machine: ${kindsError()}`
        : "Asking the machine which agents it can run…";
    if (scope() === "files" || (m.kind === "step" && m.command.args?.[m.chosen.length] === "file"))
      return filesAt()
        ? "No file matches"
        : "Open an agent or a project first: files are searched in the project in front";
    if (scope() === "messages") return "Nothing matches the last messages and output";
    return "Nothing matches";
  });

  const footerHints = computed<{ keys: string; label: string }[]>(() => {
    const m = mode();
    if (m.kind === "actions")
      return [
        { keys: keyText("enter"), label: "Run" },
        { keys: "Esc", label: "Back" },
      ];
    if (m.kind === "step")
      return [
        { keys: keyText("enter"), label: "Choose" },
        { keys: "Esc", label: "Back" },
      ];
    return [
      { keys: keyText("enter"), label: "Open" },
      { keys: keyText("mod+k"), label: "Actions" },
    ];
  });

  const preview = computed(() => {
    const m = mode();
    if (m.kind === "step" && m.command.spec.id === "newSessionIn" && m.chosen.length === 1) {
      const project = projectOf(m.chosen[0].value);
      return project ? `Starts a chat in ${projectFolder(project)}. Nothing is sent until you type.` : "";
    }
    if (m.kind === "actions") return m.row.title;
    return previewOf(current());
  });

  return (
    <PaletteDialog open={props.open} onClose={() => props.onClose()}>
      <Command
        ref={(ref) => (command = ref)}
        items={items()}
        filterable={false}
        query={text()}
        autoFocus
        loading={searching()}
        accessibilityLabel="Results"
        searchAccessibilityLabel={label()}
        placeholder={placeholder()}
        searchBarClass="h-12 shrink-0 flex-row items-center gap-3 border-b border-border px-4"
        searchClass="h-12 min-w-0 flex-1 text-base text-foreground placeholder:text-muted-foreground"
        listClass="max-h-[480px] px-1 py-2"
        itemClass="group min-h-10 flex-row items-center rounded-md px-3 focus:bg-accent hover:bg-accent"
        groupClass="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground"
        separator={false}
        renderItem={(entry) => <Row row={() => byId().get(entry.id)} />}
        header={<ArgChips chips={chips} />}
        searchSuffix={
          <If when={mode().kind === "results"}>
            <ScopeChips scope={scope} onPick={(s) => scope.set(s)} />
          </If>
        }
        onQueryChange={({ query }) => {
          const started = performance.now();
          // A query the palette rewrites (a prefix taken off, a phrase turned into a step) is first what was typed, then
          // what it means: the field only follows a change of the value it is given.
          const rewrite = (next: string, apply: () => void) => {
            text.set(query);
            setTimeout(() => {
              apply();
              text.set(next);
            }, 0);
          };
          const read = readQuery(query, scope());
          if (read.changed) {
            rewrite(read.text, () => scope.set(read.scope));
          } else {
            const said =
              mode().kind === "results" && scope() === "all" && !query.startsWith("?")
                ? phraseOf(query, commandList)
                : null;
            if (said) rewrite(said.rest, () => enterStep(said.command, said.rest));
            else text.set(query);
          }
          typing.record(performance.now() - started);
        }}
        onHighlightChange={({ highlighted: id }) => highlighted.set(id)}
        onSelect={({ id }) => choose(id)}
        onCancel={() => {
          if (!back()) props.onClose();
        }}
        empty={<Text class="px-4 py-6 text-sm text-muted-foreground">{emptyText()}</Text>}
        footer={
          <View class="min-h-10 shrink-0 flex-row items-center gap-3 border-t border-border px-4 py-2">
            <Clipped class="min-w-0 flex-1 text-xs text-muted-foreground">{preview()}</Clipped>
            <If when={searching()}>
              <Spinner />
            </If>
            <Each of={footerHints()} key="index">
              {(hint) => (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  class="shrink-0 flex-row items-center gap-1"
                >
                  <Kbd keys={hint().keys} />
                  <Text class="text-xs text-muted-foreground">{hint().label}</Text>
                </View>
              )}
            </Each>
          </View>
        }
      />
    </PaletteDialog>
  );
}

/** Whether the palette is the thing open: the shell asks to know when a key belongs to it. */
export const paletteOpen = palette;
