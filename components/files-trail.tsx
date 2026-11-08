import { signal, Text, View } from "nsh";

import { ActionMenu, Btn, Clipped, Icon } from "#kit";
import { type Crumb, crumbsOf, type TrailItem } from "#lib/file-table";

/** The pieces of the trail in points: the chevron between crumbs, the `…` menu (`ActionMenu small`), a pressable crumb's padding (`Btn small`: `px-3`), the current one's (`px-2`) and the least room left after the path for pressing to edit it (`min-w-6`). */
export const TRAIL = { chevron: 12, gap: 28, crumbPad: 24, currentPad: 16, edit: 24 } as const;
/** Points per character before the names are measured (12 pt medium; the current name is 13 pt): set high, so the first frame collapses rather than cuts. */
const CHAR = { crumb: 7.2, current: 7.8 } as const;
/** The current folder is kept whole up to this width; a longer name fades instead of pushing the search field out of the header. */
const CURRENT_MAX = 320;
/** The most the trail asks of its header: past it the current name fades. 176 keeps a 440-pt pane's search field at its least (160). */
const NEED_MAX = 176;

/**
 * The crumbs that fit `room` points, from each crumb's drawn width (`widths[i]`, padding included): all of them when
 * they fit; else the root, a `…` holding the folders left out, and as many of the last folders as still fit. The root
 * and the current folder are always kept: when even they do not fit, the current name fades (never a stub cut while
 * room is free). Pure, so the table of cases in `files-trail.test.ts` tests it.
 */
export function fitTrail(path: string, widths: readonly number[], room: number): TrailItem[] {
  const all = crumbsOf(path);
  const n = all.length;
  const item = (c: Crumb, i: number): TrailItem => ({ kind: "crumb", crumb: c, current: i === n - 1 });
  const w = (i: number) => widths[i] ?? 0;
  const total = all.reduce((sum, _, i) => sum + w(i), 0) + TRAIL.chevron * (n - 1);
  if (n <= 2 || total <= room) return all.map(item);
  let left = room - w(0) - w(n - 1) - TRAIL.gap - 2 * TRAIL.chevron;
  let from = n - 1;
  while (from > 1 && w(from - 1) + TRAIL.chevron <= left) {
    left -= w(from - 1) + TRAIL.chevron;
    from--;
  }
  if (from <= 1) return all.map(item);
  return [
    item(all[0], 0),
    { kind: "gap", hidden: all.slice(1, from) },
    ...all.slice(from).map((c, i) => item(c, from + i)),
  ];
}

/**
 * The least width the trail asks of its header: the root, the `…`, the current folder whole (up to `CURRENT_MAX`) and
 * the edit area. A flexible neighbour (the search field) gives way first, so the folder being listed is not cut while
 * the field beside it still holds its full width.
 */
export function trailNeed(widths: readonly number[]): number {
  const n = widths.length;
  if (n === 0) return 0;
  const current = Math.min(widths[n - 1], CURRENT_MAX);
  if (n === 1) return Math.min(NEED_MAX, current + TRAIL.edit);
  return Math.min(NEED_MAX, widths[0] + TRAIL.chevron + (n > 2 ? TRAIL.gap + TRAIL.chevron : 0) + current + TRAIL.edit);
}

/**
 * The folder as a breadcrumb that is the path (`design/files.md`): each segment presses to go there, a chevron between
 * them, the last one is the folder being listed (not pressable, marked current). When the path is wider than the room the
 * middle folders collapse to a `…` that opens them as a menu; the decision uses the names' drawn widths (a hidden copy
 * laid out with no clamp), not a guess per character. The empty room after the path edits it as text (`onEdit`), as
 * `mod+l` does, so the path is shown once. `fade` is the fill the header sits on (default `background`).
 */
export function FilesTrail(props: {
  path: string;
  onGo: (path: string) => void;
  onEdit?: () => void;
  fade?: readonly string[];
}) {
  const width = signal(0);
  const measured = signal<Record<string, number>>({});
  const crumbs = () => crumbsOf(props.path);
  const widths = () =>
    crumbs().map((c, i) => {
      const current = i === crumbs().length - 1;
      const text = measured()[`${current ? "c" : "a"}:${c.name}`];
      const pad = current ? TRAIL.currentPad : TRAIL.crumbPad;
      return (text ?? c.name.length * (current ? CHAR.current : CHAR.crumb)) + pad;
    });
  const items = () =>
    width() > 0 ? fitTrail(props.path, widths(), width() - TRAIL.edit) : fitTrail(props.path, [], 1e6);
  const measure = (key: string, w: number) => {
    if (measured()[key] !== w) measured.set({ ...measured(), [key]: w });
  };
  return (
    <View
      class="min-w-0 flex-1 flex-row items-center overflow-hidden"
      style={{ minWidth: trailNeed(widths()) }}
      onLayout={({ bounds }) => width.set(bounds.size.width)}
      role="navigation"
      accessibilityLabel="Folder path"
    >
      {/* The names at their natural width, in the faces the crumbs draw them in: what `fitTrail` decides by. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        class="pointer-events-none absolute left-0 top-0 flex-row opacity-0"
      >
        <Each of={crumbs()} key={(c: Crumb) => c.path}>
          {(c, index) =>
            index() === crumbs().length - 1 ? (
              <Text
                class="text-sm font-medium"
                onLayout={({ bounds }) => measure(`c:${c().name}`, Math.ceil(bounds.size.width))}
              >
                {c().name}
              </Text>
            ) : (
              <Text
                class="text-xs font-medium"
                onLayout={({ bounds }) => measure(`a:${c().name}`, Math.ceil(bounds.size.width))}
              >
                {c().name}
              </Text>
            )
          }
        </Each>
      </View>
      <Each of={items()} key={(i: TrailItem) => (i.kind === "gap" ? "gap" : i.crumb.path)}>
        {(item, index) => (
          <>
            <If when={index() > 0}>
              <Icon name="chevron-right" size={12} tone="muted-foreground" />
            </If>
            {item().kind === "gap" ? (
              <ActionMenu
                small
                label="Folders in between"
                entries={(item() as { hidden: Crumb[] }).hidden.map((c) => ({
                  label: c.name,
                  onSelect: () => props.onGo(c.path),
                }))}
              />
            ) : (
              <Crumbled
                item={item() as { crumb: Crumb; current: boolean }}
                onGo={props.onGo}
                fade={props.fade ?? ["from-background/0 to-background"]}
              />
            )}
          </>
        )}
      </Each>
      <If when={props.onEdit}>
        {(edit) => (
          <View class="h-8 min-w-6 flex-1" onPress={edit()} accessibilityLabel="Edit the path" role="button" />
        )}
      </If>
    </View>
  );
}

function Crumbled(props: {
  item: { crumb: Crumb; current: boolean };
  onGo: (path: string) => void;
  fade: readonly string[];
}) {
  return props.item.current ? (
    <View class="min-w-0 shrink px-2" accessibilityState={{ selected: true }}>
      <Clipped fade={props.fade} boxClass="min-w-0" class="text-sm font-medium text-foreground">
        {props.item.crumb.name}
      </Clipped>
    </View>
  ) : (
    // A crumb kept beside a long current name keeps its width: the current name is the one that fades.
    <View class="shrink-0">
      <Btn
        small
        variant="ghost"
        label={props.item.crumb.name}
        name={`Go to ${props.item.crumb.path}`}
        onPress={() => props.onGo(props.item.crumb.path)}
      />
    </View>
  );
}
