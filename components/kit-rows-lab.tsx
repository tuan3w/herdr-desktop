import { host, mount, signal, Text, View } from "nsh";

import type { JSX } from "nsh";
import type { DataTableSort } from "nsh/base";

import { FileModified, FileName, FileRow, FileSize } from "#components/file-row";
import { FilesTrail } from "#components/files-trail";
import { Monogram } from "#components/project-parts";
import { StatusGlyph } from "#components/status-glyph";
import {
  Avatar,
  Badge,
  Clipped,
  type Column,
  Empty,
  Keys,
  PageHeader,
  Pill,
  PopupRoot,
  Progress,
  SectionTitle,
  Skeleton,
  Spinner,
  Table,
  ThemeRoot,
} from "#kit";
import type { AgentStatus } from "#lib/status";

/**
 * Every part of the kit's text, row, table and state family in every case of the edge-case matrix at once, for the
 * `kit-rows-*` screenshots: no presses needed (a Mac shot cannot press reliably). `host.params.section` picks the page
 * (`text`, `files`, `table`, `states`), since a screenshot holds only the window. Synthetic data only. Not part of the app.
 */

const NOW = 1_794_000_000;
const LONG = `${"a-really-long-file-name-with-no-spaces-".repeat(3)}x.tsx`; // 120 characters
const CASES = {
  empty: "",
  one: "a",
  long: LONG,
  path: "/Users/dev/projects/herdr-desktop/components/kit/a-file-deep-in-the-tree.tsx",
  cjk: "設計ノート・最終版.md",
  emoji: "🚀 launch-notes 🎉.md",
  rtl: "ملاحظات التصميم.md",
  mixed: "notes-日本語-عربى-🙂.txt",
};

function Case(props: { label: string; width?: number; children?: JSX.Element }) {
  return (
    <View class="gap-1" style={props.width ? { width: props.width } : undefined}>
      <Text class="text-xs text-muted-foreground">{props.label}</Text>
      <View class="flex-row items-center gap-2">{props.children}</View>
    </View>
  );
}

function Group(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-2 border-b border-border pb-3">
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      <View class="flex-row flex-wrap gap-x-6 gap-y-3">{props.children}</View>
    </View>
  );
}

function TextPage() {
  const statuses: AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];
  return (
    <View class="gap-3">
      <Group title="Clipped (cut, fade) at 160 pt">
        <Each of={Object.entries(CASES)} key="index">
          {(c) => (
            <Case label={c()[0]} width={160}>
              <Clipped class="min-w-0 flex-1 text-sm text-foreground">{c()[1]}</Clipped>
            </Case>
          )}
        </Each>
        <Each of={Object.entries(CASES)} key="index">
          {(c) => (
            <Case label={`${c()[0]} fade`} width={160}>
              <Clipped
                fade={["from-background/0 to-background"]}
                boxClass="min-w-0 flex-1"
                class="text-sm text-foreground"
              >
                {c()[1]}
              </Clipped>
            </Case>
          )}
        </Each>
        <Case label="2 lines, long" width={160}>
          <Clipped lines={2} class="min-w-0 flex-1 text-sm text-foreground">
            {`${CASES.path} ${CASES.long}`}
          </Clipped>
        </Case>
      </Group>
      <Group title="Keys">
        <Each of={["mod+k", "mod+shift+p", "escape", "mod+alt+shift+enter", "f", "space", "?"]} key="index">
          {(k) => (
            <Case label={k()}>
              <Keys keys={k()} />
              <Keys keys={k()} tone="quiet" />
              <Keys keys={k()} tone="bare" />
            </Case>
          )}
        </Each>
      </Group>
      <Group title="Badge (count: 0, 1, 9, 42, 99, 100, 12345, -3, NaN, undefined; dot)">
        <Each of={[0, 1, 9, 42, 99, 100, 12345, -3, Number.NaN, undefined]} key="index">
          {(n) => (
            <Case label={String(n())}>
              <Badge count={n()} />
              <Badge count={n()} tone="signal" />
              <Badge count={n()} tone="danger" />
              <Badge count={n()} tone="primary" />
            </Case>
          )}
        </Each>
        <Case label="dot">
          <Badge dot />
          <Badge dot tone="signal" />
          <Badge dot tone="danger" />
        </Case>
      </Group>
      <Group title="Pill">
        <Each
          of={["idle", "Failed", "2026-11-08", "設計中", "قيد العمل", "a pill with a very long status text"]}
          key="index"
        >
          {(t, i) => (
            <Case label={`tone ${["neutral", "success", "warning", "danger", "info", "neutral"][i()]}`}>
              <Pill text={t()} tone={(["neutral", "success", "warning", "danger", "info", "neutral"] as const)[i()]} />
            </Case>
          )}
        </Each>
      </Group>
      <Group title="Avatar (fallback, broken src) and Monogram (20, 32)">
        <Each of={["TN", "", "日本", "🙂", "عل", "WWW"]} key="index">
          {(f) => (
            <Case label={`"${f()}"`}>
              <Avatar fallback={f()} />
              <Avatar fallback={f()} src="asset:missing.png" class="size-6" />
            </Case>
          )}
        </Each>
        <Each of={["payments-api", "", "a", "日本語のプロジェクト", "🚀rocket", "مشروع جديد", "web app 2"]} key="index">
          {(n) => (
            <Case label={`"${n()}"`}>
              <Monogram name={n()} size={20} />
              <Monogram name={n()} />
            </Case>
          )}
        </Each>
      </Group>
      <Group title="StatusGlyph (12, 14, 16, loud)">
        <Each of={statuses} key="index">
          {(s) => (
            <Case label={s()}>
              <StatusGlyph status={s()} size={12} />
              <StatusGlyph status={s()} size={14} />
              <StatusGlyph status={s()} size={16} />
              <StatusGlyph status={s()} size={16} loud />
            </Case>
          )}
        </Each>
      </Group>
    </View>
  );
}

function FilesPage() {
  const sizes = [0, 1, 1023, 4300, 9_999_999, 1.2 * 1024 ** 4, -5, null];
  const ages = [NOW, NOW - 300, NOW - 3 * 86400, NOW - 400 * 86400, NOW + 3 * 86400, null, undefined];
  return (
    <View class="gap-3">
      <Group title="FileRow at 440 pt (name, size, modified), long, CJK, emoji, RTL, folder, dimmed, hint">
        <View class="gap-0" style={{ width: 440 }}>
          <Each of={Object.entries(CASES)} key="index">
            {(c, i) => (
              <FileRow
                name={c()[1]}
                folder={i() === 1}
                dim={i() === 2}
                size={sizes[i() % sizes.length]}
                modified={{ at: ages[i() % ages.length], now: NOW }}
                label={c()[0]}
              />
            )}
          </Each>
          <FileRow name="auth.ts" hint={CASES.path} size={4300} modified={{ at: NOW - 60, now: NOW }} />
        </View>
        <View class="gap-0" style={{ width: 240 }}>
          <Each of={Object.entries(CASES)} key="index">
            {(c, i) => <FileRow name={c()[1]} size={sizes[i() % sizes.length]} label={c()[0]} />}
          </Each>
        </View>
      </Group>
      <Group title="FileSize / FileModified columns (right-aligned, tabular)">
        <View>
          <Each of={sizes} key="index">
            {(b) => (
              <View class="flex-row items-center gap-3">
                <Text class="w-24 text-xs text-muted-foreground">{String(b())}</Text>
                <FileSize bytes={b()} />
              </View>
            )}
          </Each>
        </View>
        <View>
          <Each of={ages} key="index">
            {(a, i) => (
              <View class="flex-row items-center gap-3">
                <Text class="w-24 text-xs text-muted-foreground">
                  {["now", "5 min", "3 days", "400 days", "future", "null", "undefined"][i()]}
                </Text>
                <FileModified modified={a()} now={NOW} />
              </View>
            )}
          </Each>
        </View>
        <View style={{ width: 300 }}>
          <FileName name={CASES.long} hint="src/components" fade={["from-background/0 to-background"]} />
          <FileName name="a.ts" hint={CASES.path} fade={["from-background/0 to-background"]} />
        </View>
      </Group>
      <Group title="FilesTrail in a header like the Files tab's, pane widths 440, 640, 900, 1400">
        <Each of={[440, 640, 900, 1400]} key="index">
          {(w) => (
            <View class="gap-1">
              <Text class="text-xs text-muted-foreground">{`${w()} pt`}</Text>
              <Each
                of={[
                  "/Users/dev/projects/herdr-desktop/docs",
                  `~/work/${CASES.long}`,
                  "~",
                  "/",
                  `/srv/${CASES.cjk}/${CASES.rtl}`,
                ]}
                key="index"
              >
                {(p) => (
                  <View class="min-h-9 flex-row items-center gap-1 border border-border px-3" style={{ width: w() }}>
                    <View class="size-7" />
                    <FilesTrail path={p()} onGo={() => {}} onEdit={() => {}} />
                    <View class="h-8 w-56 min-w-40 shrink rounded-md bg-muted" />
                    <View class="size-7" />
                  </View>
                )}
              </Each>
            </View>
          )}
        </Each>
      </Group>
    </View>
  );
}

interface Row {
  name: string;
  size: number | null;
  modified: number | null;
  state: AgentStatus;
}
const ROWS: Row[] = Object.values(CASES).map((name, i) => ({
  name,
  size: [0, 1, 4300, 9_999_999, null, 1.2 * 1024 ** 4, 77, 12][i],
  modified: [NOW, NOW - 300, null, NOW - 400 * 86400, NOW + 86400, NOW - 3 * 86400, NOW - 60, NOW - 30][i],
  state: (["blocked", "working", "done", "idle", "unknown", "working", "idle", "done"] as const)[i],
}));
const MANY: Row[] = Array.from({ length: 1000 }, (_, i) => ({
  name: `file-${i}.ts`,
  size: i * 137,
  modified: NOW - i * 3600,
  state: "idle",
}));
const COLUMNS: Column<Row>[] = [
  { key: "name", title: "Name", width: 160, grow: 1, text: (r) => r.name },
  {
    key: "size",
    title: "Size",
    width: 88,
    align: "end",
    drop: 2,
    text: (r) => (r.size === null ? "" : String(r.size)),
    sortBy: (r) => r.size ?? Number.NaN,
    cell: (r) => <FileSize bytes={r.size} />,
  },
  {
    key: "modified",
    title: "Modified",
    width: 120,
    align: "end",
    drop: 1,
    text: (r) => String(r.modified ?? ""),
    sortBy: (r) => r.modified ?? Number.NaN,
    cell: (r) => <FileModified modified={r.modified} now={NOW} />,
  },
  {
    key: "state",
    title: "",
    width: 40,
    sortable: false,
    drop: 3,
    text: (r) => r.state,
    cell: (r) => <StatusGlyph status={r.state} />,
  },
];

function TablePage() {
  const sort = signal<DataTableSort | null>({ key: "modified", direction: "descending" });
  const tables: { label: string; width: number; rows: Row[]; height: number }[] = [
    { label: "240 pt, sorted by Modified (dropped)", width: 240, rows: ROWS, height: 300 },
    { label: "440 pt", width: 440, rows: ROWS, height: 300 },
    { label: "760 pt", width: 760, rows: ROWS, height: 300 },
    { label: "440 pt, 1000 rows", width: 440, rows: MANY, height: 200 },
    { label: "440 pt, empty", width: 440, rows: [], height: 200 },
    { label: "760 pt, one row", width: 760, rows: ROWS.slice(0, 1), height: 200 },
  ];
  return (
    <View class="flex-row flex-wrap gap-4">
      <Each of={tables} key="index">
        {(t) => (
          <View class="gap-1" style={{ width: t().width, height: t().height }}>
            <Text class="text-xs text-muted-foreground">{t().label}</Text>
            <Table
              label={t().label}
              rows={t().rows}
              rowKey={(r) => r.name}
              columns={COLUMNS}
              sort={sort()}
              onSort={(s) => sort.set(s)}
              onOpen={() => {}}
              selected={t().rows[1]?.name}
              empty={<Empty title="No file matches “zzz”" hint="Clear the filter to see every file." />}
            />
          </View>
        )}
      </Each>
    </View>
  );
}

function StatesPage() {
  return (
    <View class="gap-3">
      <Group title="PageHeader / SectionTitle">
        <View style={{ width: 440 }} class="gap-3">
          <PageHeader title={LONG} subtitle="12 agents · 3 need you" />
          <PageHeader title="設計ノート" subtitle="ملاحظات التصميم" />
          <SectionTitle text={LONG} right={<Badge count={3} />} />
          <SectionTitle text="Quiet group" quiet />
        </View>
      </Group>
      <Group title="Empty: short, long, CJK, RTL, with icon (240 and 440 pt)">
        <View style={{ width: 240 }} class="border border-border">
          <Empty title="Nothing needs you" />
        </View>
        <View style={{ width: 440 }} class="border border-border">
          <Empty
            icon="folder"
            title={`No file matches “${LONG}”`}
            hint="Could not reach build-box. ssh exited with code 255 after 30 s: Connection timed out while waiting for the relay to answer."
          />
        </View>
        <View style={{ width: 240 }} class="border border-border">
          <Empty title="フォルダは空です" hint="ملف فارغ" />
        </View>
      </Group>
      <Group title="Spinner 12/14/16/20, Skeleton rows (32 pt)">
        <Case label="spinner">
          <Spinner size={12} />
          <Spinner size={14} />
          <Spinner size={16} />
          <Spinner size={20} />
        </Case>
        <View style={{ width: 300 }} class="gap-1">
          <Skeleton class="h-8 w-full" />
          <Skeleton class="h-8 w-3/4" />
        </View>
      </Group>
      <Group title="Progress: null, 0, 40, 100, 150, -10, NaN">
        <Each of={[null, 0, 40, 100, 150, -10, Number.NaN]} key="index">
          {(v) => (
            <Case label={String(v())} width={160}>
              <Progress value={v()} label="Upload" class="flex-1" />
            </Case>
          )}
        </Each>
      </Group>
    </View>
  );
}

const PAGES = { text: TextPage, files: FilesPage, table: TablePage, states: StatesPage } as const;

function Lab() {
  const section = (typeof host.params.section === "string" ? host.params.section : "text") as keyof typeof PAGES;
  const Page = PAGES[section] ?? TextPage;
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="flex-1 p-4">
          <Page />
        </View>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
