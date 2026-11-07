import { List, Text, View } from "nsh";

import type { ChangeView } from "herdr-desktop/native";

import { Clipped, FOCUS_RING_INSET, Icon, NUM, SearchField } from "#kit";
import { fileLabel, type Item, splitPath, statsText } from "#lib/changes";
import type { ChangesModel } from "#lib/changes-model";
import { ofKind } from "#lib/list-item";
import { hoverTransition } from "#lib/motion";

/** The row height the list estimates with (a heading is the same: both read as one line of text). */
const ROW_HEIGHT = 36;

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
      class={`min-h-9 w-full flex-row items-center gap-2 rounded-md px-3 hover:bg-accent ${FOCUS_RING_INSET}`}
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
      class={`min-h-9 w-full flex-row items-center gap-3 rounded-md px-3 hover:bg-accent selected:bg-accent ${FOCUS_RING_INSET}`}
    >
      <View class="min-w-0 flex-1 flex-row items-baseline gap-2" accessibilityElementsHidden>
        <Text class={`shrink-0 text-sm ${it().reviewed ? "text-muted-foreground" : "text-foreground"}`}>
          {at().name}
        </Text>
        <Clipped class="min-w-0 flex-1 text-xs text-muted-foreground">{at().dir}</Clipped>
      </View>
      <Text style={NUM} class="shrink-0 text-xs text-muted-foreground" accessibilityElementsHidden>
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
      <View class="px-3 pt-3">
        <SearchField value={model.query()} onChange={model.setQuery} placeholder="Filter changed files" />
      </View>
      <List
        each={model.items()}
        keyExtractor={(i: Item) => i.key}
        estimatedItemSize={ROW_HEIGHT}
        class="min-h-0 flex-1"
        contentClass="gap-1 px-2 pb-3"
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
