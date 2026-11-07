import { announce, computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";
import { Files } from "herdr-desktop/native";
import type { EntryView, FolderView } from "herdr-desktop/native";
import { joinPath, parentOf, showHidden } from "../lib/files";
import { Btn, Field, FOCUS_RING_INSET, Icon, IconButton, Modal, Skeleton } from "./kit";

/** The tallest the list grows before it scrolls, in points, and how many folders it draws before it says to type a path. */
const LIST_HEIGHT = 300;
const MAX_ROWS = 400;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Choose a folder on a machine: its folders only, one level at a time, starting at `start` (a `~` or an absolute path).
 * `Up one folder`, a path field that goes where it is typed, and `Use this folder`, which hands the folder shown to
 * `onPick`. The file browser (`files.tsx`) is for reading files and has no way to return a path, so this is its
 * smaller sibling for the one question the New session form asks. Hidden folders follow the browser's setting.
 */
export function FolderPicker(props: { open: boolean; machine: string; start: string; onClose: () => void; onPick: (path: string) => void }) {
  const listing = signal<FolderView | null>(null);
  const loading = signal(false);
  const failure = signal<string | null>(null);
  const typed = signal("");
  let latest = 0;

  async function go(path: string) {
    const mine = ++latest;
    loading.set(true);
    failure.set(null);
    try {
      const next = await Files.list(props.machine, path);
      if (mine !== latest) return;
      listing.set(next);
      typed.set(next.path);
      announce(`${next.path}, ${next.entries.filter((e) => e.kind === "dir").length} folders`);
    } catch (e) {
      if (mine !== latest) return;
      failure.set(reason(e));
      announce(reason(e));
    } finally {
      if (mine === latest) loading.set(false);
    }
  }

  effect(() => {
    if (!props.open) return;
    const start = props.start.trim();
    untracked(() => {
      listing.set(null);
      void go(start === "" ? "~" : start);
    });
  });

  const folders = computed(() => (listing()?.entries ?? []).filter((e: EntryView) => e.kind === "dir" && (showHidden() || !e.name.startsWith("."))));
  const here = () => listing()?.path ?? "";
  const up = () => parentOf(here());

  return (
    <Modal
      open={props.open}
      onClose={() => props.onClose()}
      title="Choose a folder"
      description="The folder the agent works in, on that machine."
      actions={
        <>
          <Btn variant="ghost" label="Cancel" onPress={() => props.onClose()} />
          <Btn
            variant="primary"
            label="Use this folder"
            disabled={listing() === null || loading() || failure() !== null}
            onPress={() => {
              props.onPick(here());
              props.onClose();
            }}
          />
        </>
      }
    >
      <View class="gap-2">
        <View class="flex-row items-end gap-2">
          <View class="min-w-0 flex-1">
            <Field label="Folder" mono value={typed()} onChange={(v) => typed.set(v)} onSubmit={() => void go(typed())} />
          </View>
          <IconButton icon="arrow-up" label="Up one folder" onPress={() => void go(up() ?? "/")} />
        </View>
        <If when={failure()}>
          {(message) => (
            <View class="flex-row items-start gap-2">
              <Icon name="alert" size={16} tone="destructive" />
              <Text class="min-w-0 flex-1 text-sm text-destructive">{message()}</Text>
            </View>
          )}
        </If>
        <If when={loading() && listing() === null}>
          <View accessibilityLabel="Loading folders" class="gap-1">
            <Skeleton class="h-8 w-full" />
            <Skeleton class="h-8 w-full" />
          </View>
        </If>
        <If when={listing()}>
          <Scroll style={{ maxHeight: LIST_HEIGHT }}>
            <View role="list" accessibilityLabel={`Folders in ${here()}`}>
              <Each of={folders().slice(0, MAX_ROWS)} key={(e: EntryView) => e.name}>
                {(entry) => (
                  <Button
                    accessibilityLabel={`Open ${entry().name}`}
                    onPress={() => void go(joinPath(here(), entry().name))}
                    class={`h-8 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent ${entry().readable ? "" : "opacity-60"} ${FOCUS_RING_INSET}`}
                  >
                    <Icon name="folder" size={16} tone="muted-foreground" />
                    <Text class="min-w-0 flex-1 text-sm text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
                      {entry().name}
                    </Text>
                    <If when={!entry().readable}>
                      <Text class="text-xs text-muted-foreground">No permission</Text>
                    </If>
                  </Button>
                )}
              </Each>
              <If when={folders().length === 0}>
                <Text class="px-2 py-3 text-sm text-muted-foreground">No folders in here. Use this folder, or go up.</Text>
              </If>
              <If when={folders().length > MAX_ROWS}>
                <Text class="px-2 py-2 text-xs text-muted-foreground">{`${folders().length - MAX_ROWS} more folders: type the path above.`}</Text>
              </If>
            </View>
          </Scroll>
        </If>
      </View>
    </Modal>
  );
}
