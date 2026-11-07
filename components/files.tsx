import { announce, computed, effect, type Signal, signal, Text, untracked, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";
import { Herdr, Files as MachineFiles } from "herdr-desktop/native";
import type { EntryView, FileData, FolderView } from "herdr-desktop/native";
import { arrange, browsing, type Browse, type Crumb, crumbs, entryLabel, fileSort, isImageName, joinPath, parentOf, showHidden, sizeText, type SortKey, modifiedText } from "#lib/files";
import { fold } from "#lib/text";
import { ActionMenu, Btn, Empty, Field, Icon, IconButton, type IconName, Modal, notify, Skeleton } from "#kit";
import { FileViewer } from "#components/file-viewer";
import { type Photo, PhotoViewer } from "#components/photo-viewer";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const ICON: Record<EntryView["kind"], IconName> = { dir: "folder", file: "file", other: "file" };

/** What one row of the list shows beyond its name; the row reads the entry by the id the list gives it. */
function EntryRow(props: { entry: () => EntryView | undefined; now: () => number }) {
  const entry = props.entry;
  return (
    <If when={entry()}>
      {(e) => (
        <View class={`w-full flex-row items-center gap-3 ${e().readable ? "" : "opacity-60"}`}>
          <Icon name={e().kind === "file" && isImageName(e().name) ? "image" : ICON[e().kind]} size={16} tone="muted-foreground" />
          <Text class="min-w-0 flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>
            {e().name}
          </Text>
          <Text class="w-20 text-right text-xs text-muted-foreground">{e().kind === "file" ? sizeText(e().size) : e().readable ? "" : "No permission"}</Text>
          <Text class="w-24 text-right text-xs text-muted-foreground">{modifiedText(e().modified, props.now())}</Text>
        </View>
      )}
    </If>
  );
}

/** The browser and the viewer of one machine, driven by the request that opened them. */
function Browser(props: { request: () => Browse; file: Signal<FileData | null> }) {
  const machine = () => props.request().machine;
  const info = computed(() => Herdr.machines().find((m) => m.id === machine()));
  const machineName = () => info()?.name ?? machine();

  const listing = signal<FolderView | null>(null);
  const loading = signal(true);
  const failure = signal<string | null>(null);
  const typed = signal("");
  const query = signal("");
  const file = props.file;
  const opening = signal(false);
  const photos = signal<{ items: Photo[]; at: number } | null>(null);
  // When the listing was read, in seconds: "3 min ago" is relative to this, and a re-render never reads a clock.
  const readAt = signal(0);
  let latest = 0;

  const go = async (path: string): Promise<void> => {
    const mine = ++latest;
    loading.set(true);
    failure.set(null);
    // Leaving the viewer happens now, not when the listing arrives: a request that names a file starts reading it at the same
    // time, and a slow listing that closed the viewer on arrival undid the file that had opened first.
    file.set(null);
    try {
      const next = await MachineFiles.list(machine(), path);
      if (mine !== latest) return;
      listing.set(next);
      typed.set(next.path);
      query.set("");
      readAt.set(Math.floor(Date.now() / 1000));
      announce(`${next.path.split("/").filter(Boolean).pop() ?? "Root"} folder, ${next.entries.length} items`);
    } catch (e) {
      if (mine !== latest) return;
      failure.set(reason(e));
      typed.set(path);
      announce(reason(e));
    } finally {
      if (mine === latest) loading.set(false);
    }
  };

  // After a failed folder the way up is from the folder that failed, not from the last one that opened.
  const here = () => (failure() !== null ? typed().trim() : (listing()?.path ?? props.request().dir));
  const shown = computed(() => arrange(listing()?.entries ?? [], { sort: fileSort(), hidden: showHidden() }));
  const byName = computed(() => new Map(shown().map((e) => [e.name, e])));
  const items = computed<CommandItem[]>(() => {
    const q = fold(query().trim());
    return shown()
      .filter((e) => q === "" || fold(e.name).includes(q))
      .map((e) => ({ id: e.name, label: entryLabel(e, readAt()), group: e.kind === "dir" ? "Folders" : "Files" }));
  });

  const openFile = async (path: string, name: string): Promise<void> => {
    if (opening()) return;
    opening.set(true);
    try {
      if (isImageName(name)) {
        // The pictures of this folder in the order they are listed, so Left and Right walk the folder.
        const pictures: Photo[] = shown()
          .filter((e) => e.kind === "file" && isImageName(e.name))
          .map((e) => ({ machine: machine(), path: joinPath(here(), e.name), name: e.name, local: info()?.local ?? false }));
        const at = pictures.findIndex((p) => p.path === path);
        photos.set({ items: at >= 0 ? pictures : [{ machine: machine(), path, name, local: info()?.local ?? false }], at: Math.max(0, at) });
        return;
      }
      const data = await MachineFiles.open(machine(), path);
      file.set(data);
      announce([`${name}, read only`, data.notice].filter(Boolean).join(". "));
    } catch (e) {
      notify(reason(e), { type: "error" });
    } finally {
      opening.set(false);
    }
  };

  const choose = (name: string) => {
    const entry = byName().get(name);
    if (!entry) return;
    const path = joinPath(here(), name);
    if (entry.kind === "dir") void go(path);
    else if (entry.kind === "file") void openFile(path, name);
    else notify(`${name} is not a regular file`);
  };

  // A new request while the dialog is open (a path pressed in a pane) goes there at once.
  effect(() => {
    const request = props.request();
    untracked(() => {
      file.set(null);
      void go(request.dir);
      if (request.file) {
        const path = request.file;
        void openFile(path, path.split("/").pop() ?? path);
      }
    });
  });

  const options = () => [
    {
      type: "radio" as const,
      label: "Sort by",
      value: fileSort(),
      onValueChange: (value: string) => fileSort.set(value as SortKey),
      items: [
        { value: "name", label: "Name" },
        { value: "modified", label: "Modified, newest first" },
        { value: "size", label: "Size, largest first" },
      ],
      closeOnClick: true,
    },
    "separator" as const,
    { type: "checkbox" as const, label: "Show hidden files", checked: showHidden(), onCheckedChange: (on: boolean) => showHidden.set(on) },
  ];

  const status = () => {
    const l = listing();
    if (!l) return "";
    const hidden = l.entries.length - shown().length;
    return [`${shown().length} ${shown().length === 1 ? "item" : "items"}`, hidden > 0 ? `${hidden} hidden` : "", l.truncated ? "Only the first 5000 entries are listed" : "", l.skipped > 0 ? `${l.skipped} names are not text and are not listed` : ""].filter(Boolean).join(" · ");
  };

  return (
    <>
      <If when={file()} else={<FolderPanel />}>
        {(data) => <FileViewer machine={machine()} machineName={machineName()} data={data()} line={props.request().line} onBack={() => file.set(null)} />}
      </If>
      <PhotoViewer
        photos={photos()?.items ?? null}
        index={photos()?.at ?? 0}
        machineName={machineName()}
        onIndex={(at) => photos.update((p) => (p ? { ...p, at } : p))}
        onClose={() => photos.set(null)}
      />
    </>
  );

  function FolderPanel() {
    return (
      <View class="gap-2">
        <View class="flex-row items-start gap-2">
          <View class="pt-6">
            <IconButton icon="arrow-up" label="Up one folder" onPress={() => void go(parentOf(here()) ?? here())} />
          </View>
          <View class="min-w-0 flex-1">
            <Field mono label="Folder" value={typed()} onChange={(v) => typed.set(v)} onSubmit={() => void go(typed().trim())} reserve={false} />
          </View>
          <View class="pt-6">
            <ActionMenu label="Folder options" entries={options()} />
          </View>
        </View>
        <View class="flex-row flex-wrap items-center gap-1" role="navigation" accessibilityLabel="Folder path">
          <Each of={crumbs(here())} key={(c: Crumb) => c.path}>
            {(c) => <Btn small variant="ghost" label={c().name} name={`Go to ${c().path}`} onPress={() => void go(c().path)} />}
          </Each>
        </View>
        <If when={failure()}>
          {(message) => (
            <View class="h-[300px] items-center justify-center">
              <Empty fill icon="alert" title="Cannot open this folder" hint={message()}>
                <View class="flex-row gap-2">
                  <Btn label="Try again" onPress={() => void go(typed().trim() || here())} />
                  <Btn label="Up one folder" onPress={() => void go(parentOf(here()) ?? "/")} />
                </View>
              </Empty>
            </View>
          )}
        </If>
        <If when={!failure() && loading() && listing() === null}>
          <View class="h-[300px] gap-2" accessibilityLabel="Loading the folder" accessibilityState={{ busy: true }}>
            <Skeleton class="h-9 w-full" />
            <Skeleton class="h-9 w-full" />
            <Skeleton class="h-9 w-full" />
          </View>
        </If>
        <If when={!failure() && listing() !== null}>
          <Command
            items={items()}
            query={query()}
            filterable={false}
            autoFocus
            accessibilityLabel="Files"
            searchAccessibilityLabel="Find in this folder"
            placeholder="Find in this folder"
            searchBarClass="mb-1 rounded-md border border-border px-3"
            searchClass="h-9 text-sm"
            listClass="h-[290px]"
            itemClass="group flex-row items-center rounded-md px-3 py-2 focus:bg-accent hover:bg-accent"
            groupClass="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground"
            renderItem={(item) => <EntryRow entry={() => byName().get(item.id)} now={readAt} />}
            onQueryChange={({ query: q }) => query.set(q)}
            onSelect={({ id }) => choose(id)}
            onCancel={() => browsing.set(null)}
            empty={<Text class="px-3 py-4 text-sm text-muted-foreground">{query().trim() ? "No file matches" : "This folder is empty"}</Text>}
          />
        </If>
        <Text class="text-xs text-muted-foreground">
          {status()}
        </Text>
      </View>
    );
  }
}

/**
 * The file browser and viewer in one dialog, on any machine: the list of a folder (folders first, name, size and when it
 * changed), a folder path to type, a breadcrumb, `Find in this folder`, sort and hidden files in `Folder options`.
 * Enter on a folder goes in, on a picture opens the picture viewer, on any other file the read-only viewer; Escape in
 * the viewer returns to the list, in the list it closes. Everything is read only: nothing here changes a file.
 * It is open while `browsing()` holds a request (`browseFiles`, `viewFile`).
 */
export function Files() {
  // The viewer is the dialog's second step: Escape leaves it first, and only then closes the dialog.
  const file = signal<FileData | null>(null);
  const close = () => {
    file.set(null);
    browsing.set(null);
  };
  return (
    <Modal open={browsing() !== null} huge onClose={() => (file() ? file.set(null) : close())} title="Files" actions={<Btn label="Close" hint="Esc" onPress={close} />}>
      <If when={browsing()}>{(request) => <Browser request={request} file={file} />}</If>
    </Modal>
  );
}
