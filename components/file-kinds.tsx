import { Files, Media } from "herdr-desktop/native";
import { announce, computed, effect, Scroll, signal, Text, untracked, View, WebView } from "nsh";

import type { ArchiveView as Archive, BytesPeek } from "herdr-desktop/native";
import type { DataTableSort } from "nsh/base";

import { CopyProgress } from "#components/copy-progress";
import { Btn, type Column, Empty, notify, Skeleton, Spinner, Table } from "#kit";
import { parseSheet } from "#lib/csv";
import { sizeText } from "#lib/files";
import { openSource } from "#lib/media-source";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The height of the content, so a viewer in a dialog has the room of a window and the dialog does not jump between files. */
export const BODY = 400;

/**
 * A PDF, drawn by the web view (WebKitGTK's own PDF.js viewer on Linux, as a spike showed, and `WKWebView`'s PDFKit on a
 * Mac: unverified there) from a loopback address that serves exactly this file with ranges (`Media.serve`; the token is
 * random and ends with the viewer). Another machine's PDF is copied into the media cache first, with progress and
 * `Cancel`. When it cannot be shown, or the person prefers it, `Open in the system viewer` is always there.
 */
export function PdfView(props: {
  machine: string;
  machineName: string;
  path: string;
  name: string;
  size: number;
  height: number;
}) {
  const opening = signal(false);
  const address = signal<string | null>(null);
  const failure = signal<string | null>(null);
  const loading = signal(true);
  const source = openSource(() => ({ machine: props.machine, path: props.path }));
  effect(() => {
    const id = source.id();
    if (source.phase() !== "ready" || id === null) return;
    untracked(() => {
      try {
        address.set(Media.serve(id));
      } catch (e) {
        failure.set(reason(e));
      }
    });
  });
  const open = () => {
    opening.set(true);
    void Files.openExternally(props.machine, props.path)
      .catch((e) => notify(`Could not open the file: ${reason(e)}`, { type: "error" }))
      .finally(() => opening.set(false));
  };
  const problem = () => failure() ?? (source.phase() === "failed" ? source.message() : undefined);
  return (
    <View class="gap-2">
      <View
        style={{ height: props.height }}
        class="items-center justify-center overflow-hidden rounded-md border border-border bg-muted"
      >
        <If when={problem()}>
          {(message) => <Empty icon="file" title="This PDF cannot be shown here" hint={message()} />}
        </If>
        <If when={!problem() && (source.phase() === "copying" || source.phase() === "starting")}>
          <If when={source.phase() === "copying"} else={<Spinner />}>
            <CopyProgress source={source} machineName={props.machineName} />
          </If>
        </If>
        <If when={!problem() ? address() : null}>
          {(url) => (
            <>
              <WebView
                src={url()}
                accessibilityLabel={`${props.name}, PDF document`}
                class="size-full"
                onLoad={() => loading.set(false)}
                onError={({ message }) => failure.set(message)}
              />
              <If when={loading()}>
                <View class="absolute" accessibilityLabel="Opening the PDF" accessibilityState={{ busy: true }}>
                  <Spinner />
                </View>
              </If>
            </>
          )}
        </If>
      </View>
      <View class="flex-row items-center gap-3">
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{`PDF document · ${sizeText(props.size)}`}</Text>
        <Btn small label="Open in the system viewer" icon="external-link" loading={opening()} onPress={open} />
      </View>
    </View>
  );
}

/** One row of the archive list. */
interface Entry {
  key: string;
  name: string;
  size: number;
  dir: boolean;
}

const ARCHIVE_COLUMNS: Column<Entry>[] = [
  { key: "name", title: "Name", width: 320, grow: 1, text: (e) => e.name, mono: true, sortable: false },
  {
    key: "size",
    title: "Size",
    width: 110,
    align: "end",
    text: (e) => (e.dir ? "" : sizeText(e.size)),
    sortBy: (e) => (e.dir ? -1 : e.size),
  },
];

/**
 * What is inside a zip, tar, tar.gz or gzip file: names and sizes, in the archive's order or sorted, never unpacked and
 * never written to disk. Over 5000 entries the list stops and says so; a format that cannot be listed says to open it with
 * the system's application.
 */
export function ArchiveView(props: { machine: string; path: string; name: string; height: number; quick?: boolean }) {
  const listing = signal<Archive | null>(null);
  const failure = signal<string | null>(null);
  const sort = signal<DataTableSort | null>(null);
  let latest = 0;
  effect(() => {
    const { machine, path } = props;
    const mine = ++latest;
    untracked(() => {
      listing.set(null);
      failure.set(null);
      Media.archive(machine, path).then(
        (found) => {
          if (mine !== latest) return;
          listing.set(found);
          announce(`${found.entries.length} entries in the ${found.format} archive`);
        },
        (e) => {
          if (mine === latest) failure.set(reason(e));
        },
      );
    });
  });
  const rows = computed<Entry[]>(() =>
    (listing()?.entries ?? []).map((e, i) => ({ key: String(i), name: e.name, size: e.size, dir: e.dir })),
  );
  const summary = () => {
    const l = listing();
    if (!l) return "";
    const files = l.entries.filter((e) => !e.dir).length;
    return [
      `${l.entries.length} ${l.entries.length === 1 ? "entry" : "entries"} · ${files} ${files === 1 ? "file" : "files"} · ${l.format}`,
      l.truncated ? "Only the first 5000 are listed" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <View class="gap-2">
      <If
        when={failure()}
        else={
          <If
            when={listing()}
            else={
              <View
                style={{ height: props.height }}
                class="gap-2"
                accessibilityLabel="Reading the archive"
                accessibilityState={{ busy: true }}
              >
                <Skeleton class="h-9 w-full" />
                <Skeleton class="h-9 w-full" />
              </View>
            }
          >
            <View style={{ height: props.height }}>
              <Table
                label={`Contents of ${props.name}`}
                rows={rows()}
                rowKey={(e) => e.key}
                columns={ARCHIVE_COLUMNS}
                sort={sort()}
                onSort={(next) => sort.set(next)}
                onOpen={() => {}}
                empty={<Text class="px-3 py-4 text-sm text-muted-foreground">This archive is empty</Text>}
              />
            </View>
          </If>
        }
      >
        {(message) => (
          <View style={{ height: props.height }} class="items-center justify-center rounded-md bg-muted">
            <Empty icon="archive" title="This archive cannot be listed" hint={message()} />
          </View>
        )}
      </If>
      <Text class="text-xs text-muted-foreground" style={{ userSelect: "text" }}>
        {summary()}
      </Text>
    </View>
  );
}

/**
 * A file that is not text: its size, the type its first bytes announce, and a hex dump of the first 4 KB (offsets, hex
 * and the printable characters), selectable and copyable. Nothing else of the file is read.
 */
export function BinaryView(props: {
  machine: string;
  path: string;
  name: string;
  size: number;
  local: boolean;
  height: number;
  quick?: boolean;
}) {
  const peek = signal<BytesPeek | null>(null);
  const failure = signal<string | null>(null);
  let latest = 0;
  effect(() => {
    const { machine, path } = props;
    const mine = ++latest;
    untracked(() => {
      peek.set(null);
      failure.set(null);
      Media.peek(machine, path).then(
        (found) => {
          if (mine === latest) peek.set(found);
        },
        (e) => {
          if (mine === latest) failure.set(reason(e));
        },
      );
    });
  });
  const kind = () => peek()?.detected;
  return (
    <View class="gap-2">
      <View class="gap-1">
        <Text class="text-base font-medium text-foreground">Not a text file</Text>
        <Text class="text-sm text-muted-foreground" style={{ userSelect: "text" }}>
          {`${props.name} · ${sizeText(props.size)}${props.local ? "" : ". Open it from the machine it is on."}`}
        </Text>
        <If when={kind()}>
          <Text class="text-sm text-foreground">{`Looks like: ${kind()}`}</Text>
        </If>
      </View>
      <If when={failure()}>
        {(message) => (
          <Text role="alert" class="text-sm text-destructive">
            {message()}
          </Text>
        )}
      </If>
      <If
        when={peek()}
        else={
          <If when={!failure()}>
            <View class="items-center py-6">
              <Spinner />
            </View>
          </If>
        }
      >
        {(found) => (
          <View
            role="group"
            accessibilityLabel={`Hex dump of the first ${found().shown} bytes of ${props.name}`}
            style={{ height: props.height - 70 }}
            class="overflow-hidden rounded-md border border-border bg-card"
          >
            <Scroll class="flex-1" contentClass="p-3">
              <Text style={{ userSelect: "text" }} class="font-mono text-xs leading-5 text-foreground">
                {found().rows.join("\n")}
              </Text>
            </Scroll>
          </View>
        )}
      </If>
      <If when={peek() && (peek()?.shown ?? 0) < props.size}>
        <Text class="text-xs text-muted-foreground">
          {`The first ${sizeText(peek()?.shown ?? 0)} of ${sizeText(props.size)} are shown`}
        </Text>
      </If>
    </View>
  );
}

/** One row of the table. */
interface Row {
  key: string;
  cells: string[];
}

/**
 * Comma, semicolon, tab or bar separated values as a table (the first row is the header, unless it is all numbers): sort
 * by a column title. The first 2000 rows are shown and the rest is said.
 */
export function CsvView(props: { text: string; name: string; height: number }) {
  const sheet = computed(() => parseSheet(props.text));
  const sort = signal<DataTableSort | null>(null);
  const columns = computed<Column<Row>[]>(() =>
    sheet().header.map((title, i) => ({
      key: String(i),
      title,
      width: 140,
      grow: 1,
      text: (row: Row) => row.cells[i] ?? "",
      // The table's own sort buttons carry no name for a screen reader (nsh draws them), so the archive and the table keep the file's order.
      sortable: false,
    })),
  );
  const rows = computed<Row[]>(() => sheet().rows.map((cells, i) => ({ key: String(i), cells })));
  return (
    <View class="gap-2">
      <View style={{ height: props.height }}>
        <Table
          label={`${props.name} as a table`}
          rows={rows()}
          rowKey={(r) => r.key}
          columns={columns()}
          sort={sort()}
          onSort={(next) => sort.set(next)}
          onOpen={() => {}}
          empty={<Text class="px-3 py-4 text-sm text-muted-foreground">This table has no rows</Text>}
        />
      </View>
      <Text class="text-xs text-muted-foreground">
        {`${sheet().rows.length} rows · ${sheet().header.length} columns${sheet().truncated ? " · Only the first 2000 rows are shown" : ""}`}
      </Text>
    </View>
  );
}

/** A preview where nothing is decoded: what it is, how big, and what Enter does. For a video or sound beside a folder's list. */
export function PlayCard(props: { name: string; kind: "video" | "audio"; size: number; height: number }) {
  return (
    <View style={{ height: props.height }} class="items-center justify-center rounded-md bg-muted">
      <Empty
        icon={props.kind === "video" ? "film" : "music"}
        title={props.name}
        hint={`${props.kind === "video" ? "Video" : "Sound"} · ${sizeText(props.size)}. Enter opens it in the player.`}
      />
    </View>
  );
}
