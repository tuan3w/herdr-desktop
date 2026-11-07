import { announce, computed, effect, signal, Text, untracked, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";
import { Files } from "herdr-desktop/native";
import type { FolderView } from "herdr-desktop/native";
import { arrange, joinPath, parentOf, sizeText } from "../lib/files";
import { fileName, MAX_FILES } from "../lib/session-compose";
import { Btn, Icon, IconButton, Modal } from "./kit";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Pick the files of a message from the session's machine: the agent reads a file where it is, so what is attached is a
 * path on that machine. A folder opens on Enter, a file ticks on Enter, `Attach` takes what is ticked (at most five).
 * The system's file chooser is not available to the app, so this lists the machine's folder, as the file browser does;
 * a file from this computer for a remote session is first sent to the machine (`Send a file`) and then ticked here.
 */
export function AttachPicker(props: { open: boolean; machine: string; folder: string; chosen: string[]; onAttach: (paths: string[]) => void; onClose: () => void }) {
  const listing = signal<FolderView | null>(null);
  const failure = signal<string | null>(null);
  const loading = signal(false);
  const query = signal("");
  const ticked = signal<string[]>([]);
  let latest = 0;

  const here = () => listing()?.path ?? props.folder;
  const go = async (path: string): Promise<void> => {
    const mine = ++latest;
    loading.set(true);
    failure.set(null);
    try {
      const next = await Files.list(props.machine, path);
      if (mine !== latest) return;
      listing.set(next);
      query.set("");
      announce(`${fileName(next.path) || "Root"} folder, ${next.entries.length} items`);
    } catch (e) {
      if (mine !== latest) return;
      failure.set(reason(e));
    } finally {
      if (mine === latest) loading.set(false);
    }
  };

  // Each time it opens it starts in the session's folder with what the message already carries ticked.
  effect(() => {
    if (!props.open) return;
    untracked(() => {
      ticked.set([...props.chosen]);
      listing.set(null);
      void go(props.folder);
    });
  });

  const shown = computed(() => arrange(listing()?.entries ?? [], { sort: "name", hidden: false }));
  const byName = computed(() => new Map(shown().map((e) => [e.name, e])));
  const items = computed<CommandItem[]>(() => {
    const q = query().trim().toLowerCase();
    return shown()
      .filter((e) => q === "" || e.name.toLowerCase().includes(q))
      .map((e) => ({ id: e.name, label: e.name, group: e.kind === "dir" ? "Folders" : "Files" }));
  });

  const choose = (name: string): void => {
    const entry = byName().get(name);
    if (!entry) return;
    const path = joinPath(here(), name);
    if (entry.kind === "dir") return void go(path);
    if (entry.kind !== "file") return;
    if (ticked().includes(path)) {
      ticked.update((all) => all.filter((p) => p !== path));
    } else if (ticked().length >= MAX_FILES) {
      announce(`At most ${MAX_FILES} files go with one message`);
    } else {
      ticked.update((all) => [...all, path]);
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Attach files"
      description={`Files on the machine the agent runs on. Enter ticks a file or opens a folder; up to ${MAX_FILES}.`}
      actions={
        <>
          <Btn label="Cancel" onPress={props.onClose} />
          <Btn
            variant="primary"
            label={ticked().length === 0 ? "Attach" : `Attach ${ticked().length}`}
            name={ticked().length === 0 ? "Attach, nothing ticked" : `Attach ${ticked().length} ${ticked().length === 1 ? "file" : "files"}`}
            disabled={ticked().length === 0}
            onPress={() => props.onAttach(ticked())}
          />
        </>
      }
    >
      <View class="gap-2">
        <View class="flex-row items-center gap-2">
          <IconButton icon="arrow-up" label="Up one folder" onPress={() => void go(parentOf(here()) ?? here())} />
          <Text class="min-w-0 flex-1 font-mono text-xs text-muted-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {here()}
          </Text>
        </View>
        <If when={failure()}>
          {(message) => (
            <View class="gap-2">
              <Text role="alert" class="text-sm text-destructive">
                {message()}
              </Text>
              <Btn small label="Up one folder" onPress={() => void go(parentOf(here()) ?? "/")} />
            </View>
          )}
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
            listClass="h-[260px]"
            itemClass="group flex-row items-center rounded-md px-3 py-2 focus:bg-accent hover:bg-accent"
            groupClass="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground"
            renderItem={(item) => {
              const entry = () => byName().get(item.id);
              const on = () => ticked().includes(joinPath(here(), item.id));
              return (
                <View class="min-w-0 flex-1 flex-row items-center gap-2" accessibilityLabel={`${item.label}${entry()?.kind === "dir" ? ", folder" : on() ? ", ticked" : ""}`}>
                  <Icon name={entry()?.kind === "dir" ? "folder" : "file"} size={14} tone="muted-foreground" />
                  <Text class="min-w-0 flex-1 text-sm text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
                    {item.label}
                  </Text>
                  <If when={entry()?.kind === "file"}>
                    <Text class="text-xs text-muted-foreground">{sizeText(entry()?.size ?? 0)}</Text>
                  </If>
                  <If when={on()}>
                    <Icon name="check" size={14} tone="primary" />
                  </If>
                </View>
              );
            }}
            onQueryChange={({ query: q }) => query.set(q)}
            onSelect={({ id }) => choose(id)}
            onCancel={props.onClose}
            empty={<Text class="px-3 py-4 text-sm text-muted-foreground">{query().trim() ? "No file matches" : "This folder is empty"}</Text>}
          />
        </If>
        <If when={loading() && listing() === null && !failure()}>
          <Text class="h-[260px] text-sm text-muted-foreground">Opening the folder…</Text>
        </If>
      </View>
    </Modal>
  );
}
