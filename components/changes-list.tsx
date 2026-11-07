import { List, Text, View } from "nsh";

import type { ChangeView } from "herdr-desktop/native";

import { Clipped, FOCUS_RING_INSET, Icon, NUM, Progress, SearchField } from "#kit";
import { fileLabel, type Item, splitPath, statsText } from "#lib/changes";
import type { ChangesModel } from "#lib/changes-model";
import { ROW } from "#lib/layout";
import { ofKind } from "#lib/list-item";
import { hoverTransition } from "#lib/motion";

/** The most characters of a file name a row shows: a longer one is cut in its middle so its extension stays. */
const NAME_MAX = 32;

/**
 * `name` with its middle cut when it is longer than `max` characters, keeping the start and the end with the extension
 * (`very-long-na\u2026ame.test.ts`): the end of a file name is what tells files apart, and nsh text has no middle ellipsis.
 */
export function splitMiddle(name: string, max: number): string {
  if ([...name].length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 9 ? name.slice(dot) : "";
  const stem = Array.from(name.slice(0, name.length - ext.length));
  const room = Math.max(2, max - [...ext].length - 1);
  const head = Math.ceil(room * 0.6);
  return `${stem.slice(0, head).join("")}\u2026${stem.slice(stem.length - (room - head)).join("")}${ext}`;
}

/** The folder as a row shows it: its last two segments, with `\u2026/` for what was left out (`a/b/c/d/` is `\u2026/c/d/`). */
export function folderTail(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.length <= 2 ? dir : `\u2026/${parts.slice(-2).join("/")}/`;
}

/** Where the selected file stands among the files the list shows now, from 1 (`at` is 0 when it is not listed). */
export function filePosition(items: readonly Item[], selected: string | undefined): { at: number; of: number } {
  const paths = items.flatMap((it) => (it.kind === "file" ? [it.change.path] : []));
  return { at: selected === undefined ? 0 : paths.indexOf(selected) + 1, of: paths.length };
}

/** The row height the list estimates with (a heading is the same: both read as one line of text). */
const ROW_HEIGHT = ROW.table.height;

function Head(props: { item: () => Extract<Item, { kind: "head" }>; model: ChangesModel }) {
  const it = props.item;
  const label = () => `${it().title}, ${it().count} ${it().count === 1 ? "file" : "files"}`;
  return (
    <View
      role="button"
      onPress={() => props.model.toggleSection(it().section)}
      accessibilityLabel={label()}
      accessibilityState={{ expanded: it().open }}
      style={hoverTransition()}
      class={`w-full flex-row items-center gap-2 rounded-md bg-background ${ROW.table.class} hover:bg-accent ${FOCUS_RING_INSET}`}
    >
      <Icon name={it().open ? "chevron-down" : "chevron-right"} size={12} tone="muted-foreground" />
      <Text class="text-xs font-medium text-muted-foreground">{it().title}</Text>
      <Text style={NUM} class="text-xs text-muted-foreground">
        {String(it().count)}
      </Text>
    </View>
  );
}

/**
 * One changed file: its name, the folder in grey, how much changed as words (`+12 −3`, never only colour) and a check once
 * it was reviewed. A press selects it; the row reads its item by the accessor the list gives, because rows are recycled.
 */
function File(props: {
  item: () => Extract<Item, { kind: "file" }>;
  model: ChangesModel;
  onOpen: (c: ChangeView) => void;
  onFocusChange: (inside: boolean) => void;
}) {
  const it = props.item;
  const change = () => it().change;
  const open = () => props.model.selected()?.path === change().path;
  const at = () => splitPath(change().path);
  return (
    <View
      role="button"
      onPress={() => props.onOpen(change())}
      accessibilityState={{ selected: open() }}
      onFocus={() => props.onFocusChange(true)}
      onBlur={() => props.onFocusChange(false)}
      accessibilityLabel={fileLabel(change(), it().reviewed)}
      style={hoverTransition()}
      class={`w-full flex-row items-center gap-3 rounded-md border-l-2 border-transparent ${ROW.table.class} hover:bg-accent/50 selected:border-primary selected:bg-accent ${FOCUS_RING_INSET}`}
    >
      <View class="min-w-0 flex-1 flex-row items-baseline gap-2" accessibilityElementsHidden>
        {/* The tip is the whole path whenever the name or the folder shows less of it. */}
        <Clipped
          label={change().path}
          class={`min-w-0 shrink text-sm ${it().reviewed ? "text-muted-foreground" : "text-foreground"}`}
        >
          {splitMiddle(at().name, NAME_MAX)}
        </Clipped>
        <Text class="min-w-0 shrink text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
          {folderTail(at().dir)}
        </Text>
      </View>
      <Text style={NUM} class="min-w-12 shrink-0 text-right text-xs text-muted-foreground" accessibilityElementsHidden>
        {statsText(change())}
      </Text>
      <View class="w-4 items-center" accessibilityElementsHidden>
        <If when={it().reviewed}>
          <Icon name="check" size={14} tone="muted-foreground" />
        </If>
      </View>
    </View>
  );
}

/** Where the group headings are: they stay at the top while their files scroll under them. */
export const headings = (items: readonly Item[]): number[] => items.flatMap((it, i) => (it.kind === "head" ? [i] : []));

/**
 * The left half of the tab: a filter and the changed files in groups (`Modified`, `Added`, ...), a heading folding its
 * group. It is a virtual list: 500 files draw a screenful. Up and Down walk the files while the list has the keyboard.
 */
export function ChangesList(props: {
  model: ChangesModel;
  onOpen: (c: ChangeView) => void;
  onFocusChange: (inside: boolean) => void;
}) {
  const model = props.model;
  const position = () => filePosition(model.items(), model.selected()?.path);
  const reviewedText = () => `${model.reviewedCount()} of ${model.files().length} reviewed`;
  return (
    <View class="min-h-0 flex-1 gap-2">
      <View class="gap-1 px-3 pt-3">
        <Text class="text-sm font-medium text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
          {model.repoName()}
        </Text>
        <View class="flex-row items-center justify-between gap-2">
          <Text style={NUM} class="text-xs text-muted-foreground">
            {position().at > 0 ? `File ${position().at} of ${position().of}` : `${position().of} files`}
          </Text>
          <Text style={NUM} class="text-xs text-muted-foreground">
            {reviewedText()}
          </Text>
        </View>
        <Progress
          value={model.files().length === 0 ? 0 : (100 * model.reviewedCount()) / model.files().length}
          label="Files reviewed"
          valueText={reviewedText()}
          class="mb-1"
        />
        <SearchField value={model.query()} onChange={model.setQuery} placeholder="Filter changed files" />
      </View>
      <List
        each={model.items()}
        keyExtractor={(i: Item) => i.key}
        estimatedItemSize={ROW_HEIGHT}
        class="min-h-0 flex-1"
        stickyHeaderIndices={headings(model.items())}
        // The right padding is the scroll bar's room (12 pt): it never covers a row's check mark.
        contentClass="gap-1 pb-3 pl-2 pr-3"
        accessibilityLabel="Changed files"
      >
        {(item) => {
          const head = ofKind(item, "head");
          const file = ofKind(item, "file");
          return (
            <If
              when={item().kind === "head"}
              else={<File item={file} model={model} onOpen={props.onOpen} onFocusChange={props.onFocusChange} />}
            >
              <Head item={head} model={model} />
            </If>
          );
        }}
      </List>
      <If when={model.query().trim() !== "" && model.items().length === 0}>
        <Text class="px-4 pb-4 text-sm text-muted-foreground">{`No changed file matches "${model.query().trim()}"`}</Text>
      </If>
    </View>
  );
}
