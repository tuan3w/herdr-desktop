import { Herdr, Files as MachineFiles } from "herdr-desktop/native";
import { announce, computed, effect, keymap, Scroll, type Signal, signal, Text, untracked, View } from "nsh";

import type { EntryView, FileData, FolderView } from "herdr-desktop/native";
import type { DataTableRef } from "nsh/base";
import type { InputRef } from "nsh/types";

import { fileActions } from "#components/file-actions";
import { FileModified, FileName, FileSize } from "#components/file-row";
import { FileViewer, type ViewerNav } from "#components/file-viewer";
import { FilesTrail } from "#components/files-trail";
import { FolderField } from "#components/folder-field";
import {
  ActionMenu,
  Btn,
  copyText,
  dialogDepth,
  Empty,
  IconButton,
  type Column,
  type MenuEntry,
  notify,
  SearchField,
  Skeleton,
  Table,
} from "#kit";
import { parseFilesKey } from "#lib/dock";
import { arrange, crumbsOf, FILE_COLUMN, type FileSortKey, firstSort, listingNote, sortOfPress } from "#lib/file-table";
import { entryLabel, fileSort, joinPath, parentOf, revealLabel, showHidden, sizeText, stepNames } from "#lib/files";
import { folderCache, sameListing } from "#lib/folder-cache";
import { requests } from "#lib/open-files";
import { fold } from "#lib/text";
import { restartable } from "#lib/timer";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The `…` of a row: the actions of one file or folder, the same as the viewer's row of buttons. */
function RowActions(props: { machine: string; dir: string; entry: EntryView; open: () => void }) {
  const path = joinPath(props.dir, props.entry.name);
  const act = fileActions({ machine: props.machine, path, name: props.entry.name });
  const entries: MenuEntry[] = [
    { label: props.entry.kind === "dir" ? "Open folder" : "Open in the viewer", onSelect: props.open },
    { label: "Copy path", onSelect: () => void copyText(path, "Path") },
    "separator",
    ...(props.entry.kind === "file"
      ? [
          { label: "Send to the agent", onSelect: act.send },
          { label: "Open with the system's application", onSelect: act.open },
        ]
      : []),
    ...(props.machine === "local" ? [{ label: revealLabel(), onSelect: act.reveal }] : []),
  ];
  return <ActionMenu small label={`Actions for ${props.entry.name}`} entries={entries} />;
}

/** The columns: the name takes the room that is left, the rest are fixed so their digits stack; the narrowest leave first. */
function columnsFor(
  machine: string,
  dir: () => string,
  now: () => number,
  open: (e: EntryView) => void,
): Column<EntryView>[] {
  return [
    {
      key: "name",
      title: "Name",
      width: FILE_COLUMN.name,
      grow: 1,
      text: (e) => e.name,
      cell: (e) => (
        <View accessibilityLabel={entryLabel(e, now())} class="w-full min-w-0 flex-row items-center">
          <FileName name={e.name} folder={e.kind === "dir"} dim={!e.readable} />
        </View>
      ),
    },
    {
      key: "size",
      title: "Size",
      width: FILE_COLUMN.size,
      align: "end",
      drop: 2,
      text: (e) => (e.kind === "file" ? sizeText(e.size) : ""),
      cell: (e) => <FileSize bytes={e.kind === "file" ? e.size : null} note={e.readable ? "" : "No permission"} />,
    },
    {
      key: "modified",
      title: "Modified",
      width: FILE_COLUMN.modified,
      align: "end",
      drop: 1,
      text: (e) => String(e.modified ?? ""),
      cell: (e) => <FileModified modified={e.modified} now={now()} />,
    },
    {
      key: "actions",
      title: "",
      width: FILE_COLUMN.actions,
      sortable: false,
      drop: 3,
      text: () => "",
      cell: (e) => <RowActions machine={machine} dir={dir()} entry={e} open={() => open(e)} />,
    },
  ];
}

/**
 * A Files tab (`files:<machine>/<folder>`): one folder of a machine as a table, beside the chat like the Changes tab is
 * (`design/files.md`). The header is the folder as a breadcrumb that is the path (the empty room after it, or `mod+l`,
 * makes it a path field that completes folders), up, `Find in this folder` and the options. The table is Name, Size and
 * Modified at fixed widths, folders first, sorted by a press on a title. A file opens in the viewer in place of the table
 * (Escape or Back returns to the folder); a picture opens in the lightbox. Everything here is read only.
 * `lib/open-files.ts` says what it was last asked to show: a folder, and with it a file to open first.
 */
export function FilesTab(props: { id: string; active: boolean }) {
  const key = parseFilesKey(props.id);
  const machine = key?.machine ?? "local";
  const request = () => requests()[props.id] ?? { machine, dir: key?.dir ?? "~" };
  const info = computed(() => Herdr.machines().find((m) => m.id === machine));
  const machineName = () => info()?.name ?? machine;

  const listing = signal<FolderView | null>(null);
  const loading = signal(true);
  const failure = signal<string | null>(null);
  const typed = signal("");
  const editing = signal(false);
  const query = signal("");
  const file: Signal<FileData | null> = signal(null);
  const opening = signal(false);
  // The preview beside the table (`Space`, `mod+y`): it follows the highlighted row once the person pauses on it.
  const quick = signal(false);
  const highlighted = signal<string | null>(null);
  const preview = signal<{ name: string; data?: FileData; note?: string; error?: string } | null>(null);
  const lag = restartable();
  let previewing = 0;
  // When the listing was read, in seconds: "3 min ago" is relative to this, and a re-render never reads a clock.
  const readAt = signal(0);
  let latest = 0;
  // The folder being shown, also while it loads or failed: the breadcrumb and the way up start from it.
  const at = signal(request().dir);

  const go = async (path: string): Promise<void> => {
    const mine = ++latest;
    // A folder seen this run shows its rows now and the machine's answer corrects them: no skeleton, and the table
    // keeps its selection when nothing changed.
    const cached = folderCache.get(machine, path);
    if (cached) {
      listing.set(cached.view);
      readAt.set(cached.at);
      typed.set(cached.view.path);
      query.set("");
    }
    loading.set(!cached);
    failure.set(null);
    at.set(cached?.view.path ?? path);
    editing.set(false);
    // Leaving the viewer happens now, not when the listing arrives: a request that names a file starts reading it at the
    // same time, and a slow listing that closed the viewer on arrival undid the file that had opened first.
    file.set(null);
    try {
      const next = await MachineFiles.list(machine, path);
      if (mine !== latest) return;
      const now = Math.floor(Date.now() / 1000);
      folderCache.put(machine, path, next, now);
      if (next.path !== path) folderCache.put(machine, next.path, next, now);
      readAt.set(now);
      at.set(next.path);
      if (cached && sameListing(cached.view, next)) return;
      listing.set(next);
      typed.set(next.path);
      if (!cached) query.set("");
      announce(`${next.path.replace(/\/+$/, "").split("/").pop() || "Root"} folder, ${next.entries.length} items`);
    } catch (e) {
      if (mine !== latest) return;
      // The rows shown stay, and "N min ago" says how old they are.
      if (!cached) {
        failure.set(reason(e));
        typed.set(path);
      }
      announce(reason(e));
    } finally {
      if (mine === latest) loading.set(false);
    }
  };

  const up = () => void go(parentOf(at()) ?? crumbsOf(at())[0].path);
  const shown = computed(() => arrange(listing()?.entries ?? [], { sort: fileSort(), hidden: showHidden() }));
  const byName = computed(() => new Map(shown().map((e) => [e.name, e])));
  const rows = computed(() => {
    const q = fold(query().trim());
    return q === "" ? shown() : shown().filter((e) => fold(e.name).includes(q));
  });

  const openFile = async (path: string, name: string): Promise<void> => {
    if (opening()) return;
    opening.set(true);
    try {
      const data = await MachineFiles.open(machine, path);
      file.set(data);
      announce([`${name}, read only`, data.notice].filter(Boolean).join(". "));
    } catch (e) {
      notify(reason(e), { type: "error" });
    } finally {
      opening.set(false);
    }
  };

  const choose = (entry: EntryView) => {
    const path = joinPath(at(), entry.name);
    if (entry.kind === "dir") void go(path);
    else if (entry.kind === "file") void openFile(path, entry.name);
    else notify(`${entry.name} is not a regular file`);
  };

  // The files the viewer steps through, and the way to the next one: the folder as it is listed now.
  const nav = computed<ViewerNav>(() => ({
    names: stepNames(shown(), file()?.name ?? ""),
    go: (name) => {
      const entry = byName().get(name);
      if (entry?.kind === "file") void openFile(joinPath(at(), name), name);
    },
  }));

  // The preview follows the highlight 200 ms after it stops moving; an answer for a row the person already left is dropped.
  effect(() => {
    if (!quick()) return;
    const name = highlighted();
    const entry = name === null ? undefined : byName().get(name);
    untracked(() => {
      const mine = ++previewing;
      if (!entry || !name) {
        preview.set(null);
        return;
      }
      if (entry.kind === "dir") {
        preview.set({ name, note: "A folder. Enter opens it." });
        return;
      }
      if (entry.kind !== "file") {
        preview.set({ name, error: `${name} is not a regular file` });
        return;
      }
      lag.after(200, () => {
        MachineFiles.open(machine, joinPath(at(), name)).then(
          (data) => {
            if (mine === previewing) preview.set({ name, data });
          },
          (e) => {
            if (mine === previewing) preview.set({ name, error: reason(e) });
          },
        );
      });
    });
  });
  const toggleQuick = () => {
    quick.update((on) => !on);
    announce(quick() ? "Preview on" : "Preview off");
  };

  // A new request while the tab is open (a path pressed in a pane) goes there at once.
  effect(() => {
    const next = request();
    untracked(() => {
      file.set(null);
      void go(next.dir);
      if (next.file) {
        const path = next.file;
        void openFile(path, path.split("/").pop() ?? path);
      }
    });
  });

  // The keyboard goes to the table once a folder is shown, so Up, Down and Enter work at once; the path field keeps it while editing.
  let table: DataTableRef | undefined;
  let filter: InputRef | undefined;
  effect(() => {
    if (!props.active || loading() || listing() === null || editing() || file() !== null || failure()) return;
    untracked(() => {
      table?.focus();
      if (rows().length > 0) table?.select({ row: 0 });
    });
  });
  // The highlight is a row that is there: the first one when the folder or the filter changes it away.
  let lit = "";
  effect(() => {
    const now = rows();
    const folder = listing()?.path ?? "";
    untracked(() => {
      const moved = folder !== lit;
      lit = folder;
      if (now.length === 0) highlighted.set(null);
      else if (moved || !now.some((e) => e.name === highlighted())) highlighted.set(now[0].name);
    });
  });
  // A letter typed with the table in front starts the filter, as typing in a file manager finds a name.
  const seed = (text: string) => {
    query.set(query() + text);
    filter?.focus();
  };

  const highlightedEntry = () => {
    const name = highlighted();
    return name === null ? undefined : byName().get(name);
  };
  // Keys of the tab, bound while it is in front and nothing modal is open. A letter key never fires inside a text field.
  effect(() => {
    if (!props.active || dialogDepth() > 0 || file() !== null) return;
    const plain = keymap.bind(
      {
        enter: () => {
          const entry = highlightedEntry();
          if (entry) choose(entry);
        },
        backspace: up,
        "mod+up": up,
        space: toggleQuick,
        "/": () => filter?.focus(),
        ...Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz0123456789.-"].map((c) => [c, () => seed(c)])),
      },
      { when: "notEditing" },
    );
    const always = keymap.bind({ "mod+l": () => editing.set(true), "mod+y": toggleQuick }, { when: "always" });
    return () => {
      plain();
      always();
    };
  });
  // Escape leaves the innermost thing first: the viewer, the path field, the preview, the filter. It never closes the tab.
  effect(() => {
    if (!props.active || dialogDepth() > 0) return;
    if (file() === null && !editing() && !quick()) return;
    return keymap.bind(
      "escape",
      () => {
        if (file()) file.set(null);
        else if (editing()) editing.set(false);
        else quick.set(false);
      },
      { when: "always" },
    );
  });

  const options = (): MenuEntry[] => [
    {
      type: "radio",
      label: "Sort by",
      value: fileSort().key,
      onValueChange: (value: string) => fileSort.set(firstSort(value as FileSortKey)),
      items: [
        { value: "name", label: "Name" },
        { value: "size", label: "Size, largest first" },
        { value: "modified", label: "Modified, newest first" },
      ],
      closeOnClick: true,
    },
    "separator",
    {
      type: "checkbox",
      label: "Show hidden files",
      checked: showHidden(),
      onCheckedChange: (on: boolean) => showHidden.set(on),
    },
    {
      type: "checkbox",
      label: "Preview beside the list",
      checked: quick(),
      onCheckedChange: () => toggleQuick(),
    },
  ];

  const note = () => {
    const l = listing();
    if (!l) return "";
    const hidden = l.entries.length - shown().length;
    return listingNote({ shown: shown().length, hidden, truncated: l.truncated, skipped: l.skipped });
  };
  const columns = columnsFor(machine, at, readAt, choose);

  function Failed(props: { message: string }) {
    const denied = /permission|denied/i.test(props.message);
    return (
      <View class="flex-1 items-center justify-center">
        <Empty
          fill
          icon="alert"
          title="Cannot open this folder"
          hint={denied ? `${props.message}. You may not read this folder: go up, or ask for access.` : props.message}
        >
          <View class="flex-row gap-2">
            <Btn label="Try again" onPress={() => void go(typed().trim() || at())} />
            <Btn label="Up one folder" onPress={up} />
          </View>
        </Empty>
      </View>
    );
  }

  const list = (
    <View class={`min-w-0 flex-1 ${loading() && listing() !== null ? "opacity-60" : ""}`}>
      <Table
        label="Files"
        rows={rows()}
        arranged
        rowKey={(e) => e.name}
        columns={columns}
        sort={fileSort()}
        onSort={(next) => fileSort.set(sortOfPress(next))}
        onRef={(ref) => (table = ref)}
        selected={highlighted() ?? undefined}
        onSelect={(e) => highlighted.set(e.name)}
        onOpen={choose}
        empty={
          <Text class="px-3 py-4 text-sm text-muted-foreground">
            {query().trim() ? "No file matches" : "This folder is empty"}
          </Text>
        }
      />
    </View>
  );

  return (
    <If
      when={file()}
      else={
        <View class="min-h-0 min-w-0 flex-1 gap-2 bg-background p-3">
          <View class="min-h-9 flex-row items-center gap-1">
            <IconButton icon="arrow-up" label="Up one folder" onPress={up} />
            <If
              when={editing()}
              else={<FilesTrail path={at()} onGo={(p) => void go(p)} onEdit={() => editing.set(true)} />}
            >
              <FolderField
                label="Folder"
                machine={machine}
                value={typed()}
                onChange={(v) => typed.set(v)}
                recents={[]}
                active
                autoFocus
                reserve={false}
                onSubmit={() => void go(typed().trim())}
              />
            </If>
            <View class="w-56 min-w-40 shrink">
              <SearchField
                dense
                inputRef={(ref) => (filter = ref)}
                value={query()}
                onChange={(v) => query.set(v)}
                placeholder="Find in this folder"
                onSubmit={() => {
                  const first = rows()[0];
                  if (first) choose(first);
                }}
              />
            </View>
            <ActionMenu small label="Folder options" entries={options()} />
          </View>
          <If when={failure()}>{(message) => <Failed message={message()} />}</If>
          <If when={!failure() && loading() && listing() === null}>
            <View class="flex-1 gap-1" accessibilityLabel="Loading the folder" accessibilityState={{ busy: true }}>
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </View>
          </If>
          <If when={!failure() && listing() !== null}>
            <View class="min-h-0 flex-1 flex-row gap-3">
              {list}
              <If when={quick()}>
                <View role="region" accessibilityLabel="Preview" class="min-w-0 flex-1">
                  <If
                    when={preview()}
                    else={
                      <Empty
                        icon="eye"
                        title="Preview"
                        hint="Move to a file and it shows here. Space closes the preview."
                      />
                    }
                  >
                    {(shownPreview) => (
                      <>
                        <If when={shownPreview().data}>
                          {(data) => (
                            <FileViewer
                              quick
                              machine={machine}
                              machineName={machineName()}
                              data={data()}
                              onBack={() => {}}
                            />
                          )}
                        </If>
                        <If when={shownPreview().note ?? shownPreview().error}>
                          {(text) => (
                            <View class="h-[300px] items-center justify-center">
                              <Empty
                                fill
                                icon={shownPreview().error ? "alert" : "folder"}
                                title={shownPreview().name}
                                hint={text()}
                              />
                            </View>
                          )}
                        </If>
                      </>
                    )}
                  </If>
                </View>
              </If>
            </View>
          </If>
          <Text class="text-xs text-muted-foreground">{note()}</Text>
        </View>
      }
    >
      {(data) => (
        <Scroll class="min-h-0 min-w-0 flex-1">
          <View class="p-3">
            <FileViewer
              machine={machine}
              machineName={machineName()}
              data={data()}
              line={request().line}
              onBack={() => file.set(null)}
              nav={nav()}
            />
          </View>
        </Scroll>
      )}
    </If>
  );
}
