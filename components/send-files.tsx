import { Files, Herdr } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, signal, Text, untracked, View } from "nsh";

import type { UploadView } from "herdr-desktop/native";

import { Btn, Field, FieldRow, Icon, Modal, notify, Progress } from "#kit";
import { sending, sizeText } from "#lib/files";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

/** What a row says about its upload, in words (the bar is only a picture of it). */
function stateText(u: UploadView): string {
  if (u.state === "running") return `${sizeText(u.sent)} of ${sizeText(u.total)}`;
  if (u.state === "done") return `Sent · ${sizeText(u.total)}`;
  if (u.state === "cancelled") return "Stopped; nothing was left on the machine";
  return u.existed ? "A file with this name is already there" : (u.message ?? "Failed");
}

function Row(props: { upload: UploadView; onReplace: (upload: UploadView) => void; onForget: (id: number) => void }) {
  const u = () => props.upload;
  return (
    <View class="gap-2 rounded-md border border-border p-3" accessibilityLabel={`${u().name}, ${stateText(u())}`}>
      <View class="flex-row items-center gap-2">
        <Icon
          name={u().state === "done" ? "circle-check" : u().state === "running" ? "upload" : "alert"}
          size={16}
          tone={u().state === "failed" ? "destructive" : "muted-foreground"}
        />
        <Text class="min-w-0 flex-1 text-sm font-medium text-foreground">{u().name}</Text>
        <If when={u().state === "running"}>
          <Btn small label="Stop" name={`Stop sending ${u().name}`} onPress={() => Files.cancelUpload(u().id)} />
        </If>
        <If when={u().state === "failed" && u().existed}>
          <Btn
            small
            variant="danger"
            label="Replace"
            name={`Replace ${u().name} on the machine`}
            onPress={() => props.onReplace(u())}
          />
        </If>
        <If when={u().state !== "running"}>
          <Btn
            small
            variant="ghost"
            label={u().state === "failed" && u().existed ? "Skip" : "Dismiss"}
            name={`Dismiss ${u().name}`}
            onPress={() => props.onForget(u().id)}
          />
        </If>
      </View>
      <If when={u().state === "running"}>
        <Progress
          value={u().total > 0 ? (u().sent / u().total) * 100 : null}
          label={`Sending ${u().name}`}
          valueText={stateText(u())}
        />
      </If>
      <Text class={`text-xs ${u().state === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
        {stateText(u())}
      </Text>
    </View>
  );
}

/**
 * `Send a file to the machine`: files dropped on a pane are copied into a folder on its machine (the pane's folder by
 * default). Nothing is sent until `Send`; a name that is already there is never overwritten unless the person presses
 * `Replace` for that file; a stopped or failed upload leaves nothing behind. It works on this computer's own files only (a
 * drop is always local) and is open while `sending()` holds a request (`PaneTab` makes it).
 */
export function SendFiles() {
  const folder = signal("");
  const checking = signal(false);
  const mistake = signal<string | undefined>(undefined);
  const mine = signal<number[]>([]);
  const all = signal<UploadView[]>([]);
  const request = () => sending();
  const machineName = () => Herdr.machines().find((m) => m.id === request()?.machine)?.name ?? request()?.machine ?? "";

  const stop = Files.onUploadChange(() => all.set(Files.uploads()));
  cleanup(stop);
  const rows = computed(() => all().filter((u) => mine().includes(u.id)));
  const running = () => rows().some((u) => u.state === "running");

  effect(() => {
    const open = request();
    untracked(() => {
      if (!open) return;
      folder.set(open.folder);
      mistake.set(undefined);
      mine.set([]);
      all.set(Files.uploads());
    });
  });

  const start = async () => {
    const open = request();
    if (!open || checking() || mine().length > 0) return;
    const where = folder().trim();
    checking.set(true);
    mistake.set(undefined);
    try {
      const stat = await Files.stat(open.machine, where);
      if (stat.kind !== "dir") {
        mistake.set(`${where} is not a folder`);
        return;
      }
      const ids = open.paths.map((path) => Files.startUpload(open.machine, path, where, false));
      mine.set(ids);
      announce(`Sending ${ids.length} ${ids.length === 1 ? "file" : "files"} to ${machineName()}`);
    } catch (e) {
      mistake.set(reason(e));
    } finally {
      checking.set(false);
    }
  };

  const replace = (u: UploadView) => {
    const open = request();
    const source = open?.paths.find((p) => baseName(p) === u.name);
    if (!open || !source) return;
    try {
      const id = Files.startUpload(open.machine, source, folder().trim(), true);
      mine.update((ids) => [...ids.filter((i) => i !== u.id), id]);
      Files.forgetUpload(u.id);
    } catch (e) {
      notify(reason(e), { type: "error" });
    }
  };

  const forget = (id: number) => {
    Files.forgetUpload(id);
    mine.update((ids) => ids.filter((i) => i !== id));
  };

  const close = () => {
    for (const u of rows()) if (u.state === "running") Files.cancelUpload(u.id);
    const done = rows().filter((u) => u.state === "done").length;
    if (done > 0) notify(done === 1 ? `Sent 1 file to ${machineName()}` : `Sent ${done} files to ${machineName()}`);
    for (const u of rows()) Files.forgetUpload(u.id);
    sending.set(null);
  };

  const started = () => mine().length > 0;
  // The end of a send is said once, when the last file arrived.
  effect(() => {
    if (started() && !running() && rows().length > 0 && rows().every((u) => u.state === "done"))
      announce(rows().length === 1 ? "Sent 1 file" : `Sent ${rows().length} files`);
  });
  const names = () => request()?.paths.map(baseName).join(", ") ?? "";
  return (
    <Modal
      open={request() !== null}
      onClose={close}
      title={`Send to ${machineName()}`}
      description={`${request()?.paths.length ?? 0} ${request()?.paths.length === 1 ? "file" : "files"}: ${names()}`}
      disablePointerDismissal
      actions={
        <>
          <If when={!started()}>
            <Btn variant="ghost" label="Cancel" onPress={close} />
            <Btn variant="primary" label="Send" hint="↵" loading={checking()} onPress={() => void start()} />
          </If>
          <If when={started()}>
            <Btn label={running() ? "Stop and close" : "Close"} onPress={close} />
          </If>
        </>
      }
    >
      <View class="gap-3">
        <If when={!started()}>
          <FieldRow>
            <Field
              autoFocus
              mono
              reserve
              label="Into this folder on the machine *"
              value={folder()}
              onChange={(v) => {
                folder.set(v);
                mistake.set(undefined);
              }}
              onSubmit={() => void start()}
              error={mistake()}
              hint="An absolute path. A file with the same name is never replaced without asking."
            />
          </FieldRow>
        </If>
        <If when={started() && mistake()}>
          <Text class="text-sm text-destructive">{mistake()}</Text>
        </If>
        <Each of={rows()} key={(u: UploadView) => u.id}>
          {(u) => <Row upload={u()} onReplace={replace} onForget={forget} />}
        </Each>
      </View>
    </Modal>
  );
}
