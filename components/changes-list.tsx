import { List, Text, View } from "nsh";

import type { ChangeView } from "herdr-desktop/native";

import { Clipped, FOCUS_RING_INSET, Icon, NUM, SearchField } from "#kit";
import { fileLabel, type Item, KIND_MARK, splitPath, statsText } from "#lib/changes";
import type { ChangesModel } from "#lib/changes-model";
import { ROW } from "#lib/layout";
import { ofKind } from "#lib/list-item";
import { hoverTransition } from "#lib/motion";

/** The row height the list estimates with (a heading is a little lower: both read as one line of text). */
const ROW_HEIGHT = ROW.agentCompact.height;

/**
 * What a cut name or folder fades into (`Clipped` `fade`): the fills a row can have, laid in order (the page, the hover
 * tint, the selected fill), the same tokens as the row's own classes so the fade and the fill are one colour.
 */
const FADE = "from-background/0 to-background";
const FADE_HOVER = "from-accent/0 to-accent/50 opacity-0 group-hover/row:opacity-100";
const FADE_OPEN = "from-accent/0 to-accent";

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
      class={`w-full flex-row items-center gap-2 rounded-md bg-background ${ROW.project.class} hover:bg-accent ${FOCUS_RING_INSET}`}
    >
      <Icon name={it().open ? "chevron-down" : "chevron-right"} size={12} tone="muted-foreground" />
      <Text class="text-xs font-medium text-muted-foreground">{it().title}</Text>
      <Text style={NUM} class="text-xs text-muted-foreground">
        {String(it().count)}
      </Text>
    </View>
  );
}

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
 * One changed file: a one-letter state in a fixed column, the name whole, the folder in grey after it (it fades first
 * when the row is short), how much changed at the end, and a check once it was reviewed. The selected row is one fill. A
 * press selects it; the row reads its item by the accessor the list gives, because rows are recycled.
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
      class={`group/row w-full flex-row items-center gap-2 rounded-md ${ROW.agentCompact.class} hover:bg-accent/50 selected:bg-accent ${FOCUS_RING_INSET}`}
    >
      <Text
        style={NUM}
        class={`w-4 shrink-0 text-center text-xs font-medium ${change().kind === "conflicted" ? "text-warning" : "text-muted-foreground"}`}
        accessibilityElementsHidden
      >
        {KIND_MARK[change().kind]}
      </Text>
      <View class="min-w-0 flex-1 flex-row items-center gap-2" accessibilityElementsHidden>
        {/* The tip is the whole path whenever the name or the folder shows less of it. */}
        <Clipped
          label={change().path}
          fade={open() ? [FADE_OPEN] : [FADE, FADE_HOVER]}
          boxClass="min-w-0 shrink"
          class="pr-1 text-sm text-foreground"
        >
          {at().name}
        </Clipped>
        <Clipped
          label={change().path}
          tip={false}
          fade={open() ? [FADE_OPEN] : [FADE, FADE_HOVER]}
          boxClass="min-w-0 shrink-[8]"
          class="pr-1 text-xs text-muted-foreground"
        >
          {at().dir}
        </Clipped>
      </View>
      <View class="shrink-0" accessibilityElementsHidden>
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
 * The left half of the tab: a filter and the changed files in groups (`Modified`, `Added`, ...), a heading folding its
 * group. It is a virtual list: 500 files draw a screenful. Up and Down walk the files while the list has the keyboard.
 */
export function ChangesList(props: {
  model: ChangesModel;
  onOpen: (c: ChangeView) => void;
  onFocusChange: (inside: boolean) => void;
}) {
  const model = props.model;
  return (
    <View class="min-h-0 flex-1 gap-2">
      <View class="px-2 pt-2">
        <SearchField dense value={model.query()} onChange={model.setQuery} placeholder="Filter changed files" />
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
