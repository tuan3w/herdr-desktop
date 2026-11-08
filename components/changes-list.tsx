import { List, Text, View } from "nsh";

import type { ChangeView } from "herdr-desktop/native";
import type { InputRef } from "nsh/types";

import { Clipped, FOCUS_RING_INSET, GroupHeading, Icon, IconButton, NUM, SearchField } from "#kit";
import { fileLabel, type Item, KIND_MARK, statsText } from "#lib/changes";
import type { ChangesModel } from "#lib/changes-model";
import { CONFLICTS, nameOf } from "#lib/changes-tree";
import { ROW } from "#lib/layout";
import { ofKind } from "#lib/list-item";
import { hoverTransition } from "#lib/motion";

/** The row height the list estimates with (a heading is a little lower: both read as one line of text). */
const ROW_HEIGHT = ROW.agentCompact.height;

/**
 * A folder heading: the folder's whole path once (`native/app/src`), which the files under it do not repeat, and how many
 * files it holds (`GroupHeading` of the kit). A path too long for the column ends in an ellipsis and the tip has all of it.
 */
function Head(props: { item: () => Extract<Item, { kind: "head" }>; model: ChangesModel }) {
  const it = props.item;
  return (
    <GroupHeading
      title={it().title}
      count={it().count}
      noun={["file", "files"]}
      open={it().open}
      onToggle={() => props.model.toggleSection(it().group)}
      tone={it().group === CONFLICTS ? "warning" : it().section ? "strong" : "muted"}
      indent={it().nested}
    />
  );
}

/** The tone of a state's letter: a conflict warns, the rest are quiet. */
const markTone = (kind: ChangeView["kind"]): string =>
  kind === "conflicted" ? "text-warning" : "text-muted-foreground";

/** How much changed in a file: `+12` green and `\u221218` red, or the word when git counted no lines (`binary`, a size). */
function Stats(props: { change: ChangeView }) {
  const counted = () => !props.change.binary && !props.change.submodule && props.change.added != null;
  return (
    <If
      when={counted()}
      else={
        <Text style={NUM} class="shrink-0 text-right text-xs text-muted-foreground">
          {statsText(props.change)}
        </Text>
      }
    >
      <View class="shrink-0 flex-row gap-1.5">
        <Text style={NUM} class="text-right text-xs text-success">{`+${props.change.added ?? 0}`}</Text>
        <Text style={NUM} class="text-right text-xs text-destructive">{`\u2212${props.change.removed ?? 0}`}</Text>
      </View>
    </If>
  );
}

/**
 * One changed file under its folder: a quiet mark only for what is not an ordinary edit (A, D, R, U, `!`), the name
 * whole in the room that is left, how much changed in a column of its own at the end, and a check once reviewed. The
 * name is the one thing that is never cut for another part; only a name longer than the whole row ends in an ellipsis,
 * with the full path in the tip. The selected row is one fill. A press selects it; the row reads its item by the accessor
 * the list gives, because rows are recycled.
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
  const mark = () => (change().kind === "modified" ? "" : KIND_MARK[change().kind]);
  return (
    <View
      role="button"
      onPress={() => props.onOpen(change())}
      accessibilityState={{ selected: open() }}
      onFocus={() => props.onFocusChange(true)}
      onBlur={() => props.onFocusChange(false)}
      accessibilityLabel={fileLabel(change(), it().reviewed)}
      style={hoverTransition()}
      class={`w-full flex-row items-center gap-2 rounded-md ${ROW.agentCompact.class} ${it().nested ? "pl-12" : "pl-6"} hover:bg-accent/50 selected:bg-accent ${FOCUS_RING_INSET}`}
    >
      <Text
        style={NUM}
        class={`w-3 shrink-0 text-center text-xs font-medium ${markTone(change().kind)}`}
        accessibilityElementsHidden
      >
        {mark()}
      </Text>
      <View class="min-w-0 flex-1" accessibilityElementsHidden>
        <Clipped label={change().path} class={`text-sm ${it().reviewed ? "text-muted-foreground" : "text-foreground"}`}>
          {nameOf(change().path)}
        </Clipped>
      </View>
      <View class="min-w-16 shrink-0 items-end" accessibilityElementsHidden>
        <Stats change={change()} />
      </View>
      <View class="w-4 shrink-0 items-center" accessibilityElementsHidden>
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
 * The left half of the tab: a filter and the changed files grouped by folder (conflicts first), a heading folding its
 * folder. It is a virtual list: 500 files draw a screenful. Up and Down walk the files while the list has the keyboard.
 */
export function ChangesList(props: {
  model: ChangesModel;
  onOpen: (c: ChangeView) => void;
  onFocusChange: (inside: boolean) => void;
  /** Hands out the filter field, so the sheet that holds the list can put the keyboard in it. */
  filterRef?: (ref: InputRef) => void;
}) {
  const model = props.model;
  const bySize = () => model.sort() === "size";
  return (
    <View class="min-h-0 flex-1 gap-2">
      <View class="flex-row items-center gap-1 px-2 pt-2">
        <View class="min-w-0 flex-1">
          <SearchField
            dense
            inputRef={props.filterRef}
            value={model.query()}
            onChange={model.setQuery}
            placeholder="Filter changed files"
          />
        </View>
        <IconButton
          icon="sliders"
          label="Biggest change first"
          selected={bySize()}
          onPress={() => model.setSort(bySize() ? "path" : "size")}
        />
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
