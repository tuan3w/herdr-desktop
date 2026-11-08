import {
  announce,
  cleanup,
  computed,
  effect,
  type JSX,
  keymap,
  List,
  Overlay,
  Scroll,
  type Signal,
  signal,
  Text,
  View,
  windowSize,
} from "nsh";

import type { Bounds, ListRef, MouseEvent, OverlayPosition, Point, ScrollRef, ViewRef } from "nsh/types";

import { keycaps } from "#lib/keycaps";
import { hoverTransition } from "#lib/motion";
import { apple } from "#lib/shortcuts";
import { fold } from "#lib/text";

import { EDGE, FOCUS_RING } from "./core";
import { dialogDepth } from "./dialog-stack";
import { Tipped } from "./hint";
import { Icon, type IconName } from "./icon";
import { Keys } from "./keys";
import {
  alignSelected,
  centerOffset,
  createHoverIntent,
  edgeIndex,
  inTransit,
  isTyping,
  offsetsOf,
  pageIndex,
  revealOffset,
  stepIndex,
  TYPING_KEYS,
  type Typing,
  typeahead,
} from "./navigation";
import { createOpenState, type OpenChange, type OpenReason } from "./popup";
import { anchorMoved, type Hung } from "./positioner";

/** What every entry that can be chosen has. */
interface Choosable {
  label: string;
  icon?: IconName;
  /** Shown as a keycap: the shortcut that does the same without the menu. */
  shortcut?: string;
  /**
   * One letter that runs this item while THIS menu is open, shown as a quiet hint in the shortcut's slot (an item has
   * either, not both: with both the keycap is dropped). Bound only while the menu is open, never global. See `routeLetter`.
   */
  accelerator?: string;
  /** Highlighted by the keys and the pointer like any row, but choosing it does nothing (Base UI keeps it focusable). */
  disabled?: boolean;
  /**
   * Why a `disabled` row cannot be chosen ("No editor set"), a few words: drawn quietly at the row's end in place of its
   * keys, and spoken with its name. Ignored while the row is enabled.
   */
  reason?: string;
}

/** An action: chosen, it runs `onSelect` and closes the menu unless `closeOnClick` is false. */
export interface MenuAction extends Choosable {
  danger?: boolean;
  closeOnClick?: boolean;
  onSelect: () => void;
}

/** A setting that is on or off; the menu stays open when it is chosen (set `closeOnClick` to close it). The owner holds `checked`. */
export interface MenuCheckbox extends Choosable {
  type: "checkbox";
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  closeOnClick?: boolean;
}

/** One choice of a `MenuRadioGroup`. */
export interface MenuRadio extends Choosable {
  value: string;
}

/** One value out of several, ticked in the list. Use it for "the current stage". The menu stays open unless `closeOnClick`. */
export interface MenuRadioGroup {
  type: "radio";
  /** A heading above the choices. */
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  items: MenuRadio[];
  disabled?: boolean;
  closeOnClick?: boolean;
}

/** Entries under a heading (Base UI's `Menu.Group` and `GroupLabel`). Not a submenu: see `MenuGroup`. */
export interface MenuSection {
  type: "group";
  label: string;
  items: MenuEntry[];
}

/** A row that opens a submenu of `items`. */
export interface MenuGroup {
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** Why a `disabled` submenu cannot open; see `Choosable`. */
  reason?: string;
  items: MenuEntry[];
}

/** An action, a checkbox, radios, a heading with entries, a submenu, or a divider between groups. */
export type MenuEntry = MenuAction | MenuCheckbox | MenuRadioGroup | MenuSection | MenuGroup | "separator";

/** A row that can be chosen: what the entries and a select's options both come down to. */
export interface ItemRow {
  kind: "item" | "check" | "radio";
  label: string;
  icon?: IconName;
  shortcut?: string;
  /** Lower case, one of `TYPING_KEYS`; see `Choosable`. */
  accelerator?: string;
  danger: boolean;
  disabled: boolean;
  /** Why it is disabled; only set while it is. */
  reason?: string;
  checked: boolean;
  closeOnClick: boolean;
  select: () => void;
}
export interface SubmenuRow {
  kind: "submenu";
  label: string;
  icon?: IconName;
  disabled: boolean;
  reason?: string;
  items: MenuEntry[];
}
/** What a menu is drawn from, one per row. */
export type MenuRow =
  | ItemRow
  | SubmenuRow
  | { kind: "label"; label: string }
  | { kind: "separator"; label?: undefined };

const isItem = (row: MenuRow): row is ItemRow => row.kind === "item" || row.kind === "check" || row.kind === "radio";
const isChecked = (row: MenuRow) => isItem(row) && row.checked;

/**
 * The rows of `entries`, flat: a heading is a row of its own, radios take the group's value, and dividers that would sit
 * first, last or twice in a row are dropped (menus built from conditions leave them behind).
 */
export function menuRows(entries: readonly MenuEntry[]): MenuRow[] {
  const rows: MenuRow[] = [];
  const add = (list: readonly MenuEntry[]) => {
    for (const entry of list) {
      if (entry === "separator") {
        if (rows.length > 0 && rows[rows.length - 1].kind !== "separator") rows.push({ kind: "separator" });
      } else if ("type" in entry) {
        if (entry.type === "checkbox") {
          rows.push({
            kind: "check",
            label: entry.label,
            icon: entry.icon,
            shortcut: entry.shortcut,
            accelerator: letterOf(entry),
            danger: false,
            disabled: !!entry.disabled,
            reason: entry.disabled ? entry.reason : undefined,
            checked: entry.checked,
            closeOnClick: entry.closeOnClick ?? false,
            select: () => entry.onCheckedChange(!entry.checked),
          });
        } else if (entry.type === "radio") {
          if (entry.label) rows.push({ kind: "label", label: entry.label });
          for (const item of entry.items) {
            rows.push({
              kind: "radio",
              label: item.label,
              icon: item.icon,
              shortcut: item.shortcut,
              accelerator: letterOf(item),
              danger: false,
              disabled: !!(entry.disabled || item.disabled),
              reason: entry.disabled || item.disabled ? item.reason : undefined,
              checked: entry.value === item.value,
              closeOnClick: entry.closeOnClick ?? false,
              select: () => entry.onValueChange(item.value),
            });
          }
        } else {
          rows.push({ kind: "label", label: entry.label });
          add(entry.items);
        }
      } else if ("items" in entry) {
        rows.push({
          kind: "submenu",
          label: entry.label,
          icon: entry.icon,
          disabled: !!entry.disabled,
          reason: entry.disabled ? entry.reason : undefined,
          items: entry.items,
        });
      } else {
        rows.push({
          kind: "item",
          label: entry.label,
          icon: entry.icon,
          shortcut: entry.shortcut,
          accelerator: letterOf(entry),
          danger: !!entry.danger,
          disabled: !!entry.disabled,
          reason: entry.disabled ? entry.reason : undefined,
          checked: false,
          closeOnClick: entry.closeOnClick ?? true,
          select: entry.onSelect,
        });
      }
    }
  };
  add(entries);
  if (rows.length > 0 && rows[rows.length - 1].kind === "separator") rows.pop();
  const taken = new Set<string>();
  for (const row of rows) {
    if (!isItem(row) || !row.accelerator) continue;
    if (taken.has(row.accelerator)) {
      row.accelerator = undefined;
      warnOnce(`menu: "${row.label}" repeats an accelerator: the first item that has it wins`);
    } else taken.add(row.accelerator);
  }
  return rows;
}

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** The accelerator of an entry as stored on its row: one plain letter or digit, folded; anything else is dropped with a warning. */
function letterOf(entry: Choosable): string | undefined {
  const key = entry.accelerator?.toLowerCase();
  if (key === undefined) return undefined;
  if (!TYPING_KEYS.includes(key)) {
    warnOnce(`menu: the accelerator "${entry.accelerator}" of "${entry.label}" must be one letter or digit`);
    return undefined;
  }
  if (entry.shortcut)
    warnOnce(`menu: "${entry.label}" has a shortcut and an accelerator: only the accelerator is shown`);
  return key;
}

/**
 * What a plain letter does in the open menu's innermost panel. An accelerator wins over type-to-find, but only in a menu
 * that declares one, and only while no word is being typed: "re" must still find "Rename" when `r` is an accelerator, so
 * a letter that continues a live word stays typing. A disabled item's letter does nothing special (it types). Pure.
 */
export function routeLetter(
  rows: readonly MenuRow[],
  key: string,
  typingLive: boolean,
): { kind: "accelerator"; index: number } | { kind: "type" } {
  if (typingLive) return { kind: "type" };
  const index = rows.findIndex((r) => isItem(r) && r.accelerator === key && !r.disabled);
  return index >= 0 ? { kind: "accelerator", index } : { kind: "type" };
}

const POPUP = `min-w-44 max-w-80 rounded-lg bg-popover p-1 text-popover-foreground ${EDGE.md}`;
/** `POPUP`'s least and greatest width (`min-w-44`, `max-w-80`): a label is cut with an ellipsis only past the greatest. */
const MENU_MIN = 176;
const MENU_MAX = 320;
/** An average glyph of the 14pt body face (a wide character counts twice) and the text is estimated, not measured, because the popup is sized before it is built. */
const GLYPH = 7.5;
const glyphs = (text: string) => [...text].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);

/** The 12-pt text at a row's end (keys, a reason): a key symbol (`⌘`, `⇧`, `↩`, `↑`) is about square, a space narrow, a letter about 7. */
const smallWidth = (text: string) =>
  [...text].reduce((n, c) => {
    const code = c.codePointAt(0) ?? 0;
    if ((code >= 0x2190 && code <= 0x21ff) || (code >= 0x2300 && code <= 0x23ff)) return n + 12;
    return n + (c === " " ? 3.5 : code >= 0x2e80 ? 13 : 7);
  }, 0);

/**
 * What a row shows at its end, as drawn: the reason of a disabled row, else its keys (accelerator or shortcut) written for
 * the platform, `undefined` when nothing. `menuWidth` sizes it and `RowContent` draws it, so the two cannot disagree.
 */
export function rowTrail(row: ItemRow | SubmenuRow, onApple: boolean = apple()): string | undefined {
  if (row.disabled && row.reason) return row.reason;
  const keys = row.kind === "submenu" ? undefined : rowKeys(row);
  return keys ? keycaps(keys, onApple).join(" ") : undefined;
}

/**
 * How wide a menu is: as its longest row needs (the icon column, the label, a tick or chevron, the keys or the reason at
 * the end, and the gaps and paddings between), at least `MENU_MIN` and at most `MENU_MAX`. Without it the popup took its
 * width from the layout pass and cut "Add a note on this change" with an ellipsis although there was room. The keys are
 * sized as they are written on this platform: `Ctrl Shift N` is more than twice as wide as `⌘ ⇧ N`, and counting caps
 * cut Linux labels.
 */
export function menuWidth(rows: readonly MenuRow[], onApple: boolean = apple()): number {
  const icons = rows.some((r) => r.kind !== "label" && r.kind !== "separator" && !!r.icon);
  let widest = 0;
  for (const row of rows) {
    if (row.kind === "separator") continue;
    let w = glyphs(row.label) * GLYPH;
    if (row.kind !== "label") {
      // The spacer after the label is a flex child of its own: the row's gap comes before it too.
      w += 12;
      if (icons) w += 16 + 12;
      if (row.kind === "submenu" || row.kind === "check" || row.kind === "radio") w += 14 + 12;
      const trail = rowTrail(row, onApple);
      if (trail) w += 12 + smallWidth(trail);
    }
    widest = Math.max(widest, w);
  }
  // The popup's border and padding (10) and a row's padding (24).
  return Math.min(MENU_MAX, Math.max(MENU_MIN, Math.ceil(widest) + 34));
}

/** The colours of a row's label and icon: a row that cannot be chosen is plain muted, whatever it would be (a danger row is not pink while it is off). */
export function rowTone(row: ItemRow | SubmenuRow): { text: string; icon: "muted-foreground" | "destructive" } {
  const danger = row.kind !== "submenu" && row.danger;
  if (row.disabled) return { text: "text-muted-foreground", icon: "muted-foreground" };
  return danger
    ? { text: "text-destructive", icon: "destructive" }
    : { text: "text-popover-foreground", icon: "muted-foreground" };
}

/** `POPUP`'s border (1) and padding (4): how far a submenu rises above its row so the first rows line up. */
const POPUP_INSET = 5;
/** `POPUP_INSET` on both sides: what a popup is taller than its rows. */
const CHROME = POPUP_INSET * 2;
/** Pointer tiers (`CONTROL`, `ROW` in `lib/layout.ts`): an item is a 32-pt control row, a group heading a 28-pt quiet one. Keep equal to `ITEM` and the heading class. */
const ITEM_HEIGHT = 32;
const HEADING_HEIGHT = 28;
/** A divider's line (1) and its margins (4 and 4). */
const DIVIDER_HEIGHT = 9;
const MARGIN = 8;
/** The tallest a list of rows grows before it scrolls: 11.5 rows, so the last one shows half and says the list goes on (at 384, 12 whole rows ended flush and a 40-row menu looked complete). */
const MAX_ROWS_HEIGHT = 368;
/** Above this many rows a scrolling menu is a `List`: only the rows in view exist. */
const VIRTUAL_ROWS = 30;
const ITEM = "h-8 flex-row items-center gap-3 rounded-md px-3";
/** A choice list's rows hang like its trigger's text: the trigger has a border (1) and 10pt of padding. */
const CHOICE_ITEM = "h-8 flex-row items-center gap-3 rounded-md px-2";
/** The pointer must rest this long on a submenu's row, with no other submenu open, before it opens. */
const OPEN_DELAY = 100;
/** A press on the trigger this soon after a hover opened the menu keeps it open: the user meant to open it (Base UI's `PATIENT_CLICK_THRESHOLD`). */
const PATIENT_CLICK_MS = 500;

function heightOf(row: MenuRow): number {
  return row.kind === "separator" ? DIVIDER_HEIGHT : row.kind === "label" ? HEADING_HEIGHT : ITEM_HEIGHT;
}

/**
 * Whether a popup of `popup` points surely fits on one side of any trigger up to `anchorHeight` tall, wherever the trigger
 * is: the larger side always has at least half of what the window leaves. Such a menu is shown at once; a taller one waits
 * one measure of its trigger, so it is built once at its final height instead of appearing whole and then being cut
 * (a visible jump of the whole panel).
 */
export function surelyFits(popup: number, windowHeight: number, gap: number, anchorHeight = 44): boolean {
  return popup <= (windowHeight - anchorHeight - 2 * gap - 2 * MARGIN) / 2;
}

/** Where a trigger is, in the window: the top and bottom of its frame. */
export interface Span {
  top: number;
  bottom: number;
}

/** The room a popup has above and below its trigger: the window less the margin and the gap to the trigger. */
export function roomAround(trigger: Span, gap: number, windowHeight: number): { above: number; below: number } {
  return { above: trigger.top - gap - MARGIN, below: windowHeight - MARGIN - (trigger.bottom + gap) };
}

/**
 * How tall the rows may be so the popup keeps off its trigger, or `undefined` when a popup of `popup` points (rows and
 * its own border and padding) fits on one side as it is. nsh places a popup that fits neither side on the larger one and
 * clamps it into the window, which lays it over its own trigger: so it is cut to the larger side's room and its rows
 * scroll (shadcn's `max-h-(--available-height)`, Base UI's `--available-height`).
 */
export function fitRows(popup: number, room: { above: number; below: number }): number | undefined {
  if (popup <= room.below || popup <= room.above) return undefined;
  return Math.max(ITEM_HEIGHT, Math.max(room.above, room.below) - CHROME);
}

/** The first of the ascending `offsets` that is at least `at` (the end when none is). */
function boundaryFrom(offsets: readonly number[], at: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Moves a list's opening offset to a row boundary, so the first visible row is whole rather than cut mid-glyph. At the
 * end of the list the offset stays flush with it (the top row is then the one that shows a part, a peek of the side that
 * has more). `keep` is a row that must stay fully in view (the selected one): the offset moves the least that shows it.
 */
export function snapScroll(offsets: readonly number[], scroll: number, height: number, keep?: number): number {
  const content = offsets[offsets.length - 1];
  const last = Math.max(0, content - height);
  const at = Math.min(Math.max(scroll, 0), last);
  const next = boundaryFrom(offsets, at);
  const before = Math.max(0, next - 1);
  const near = at - offsets[before] <= offsets[next] - at ? offsets[before] : offsets[next];
  let snapped = Math.min(near, last);
  if (keep !== undefined && offsets[keep + 1] !== undefined) {
    const top = offsets[keep];
    const bottom = offsets[keep + 1];
    if (top < snapped) snapped = top;
    else if (bottom > snapped + height) snapped = Math.min(last, offsets[boundaryFrom(offsets, bottom - height)]);
  }
  return snapped;
}

/** What a screen reader hears for a row: its label, the submenu it is in, and whether it is the value. */
function nameOf(row: MenuRow, within?: string): string {
  const mark =
    row.kind === "radio" && row.checked ? ", selected" : row.kind === "check" && row.checked ? ", checked" : "";
  const why =
    (row.kind === "item" || row.kind === "check" || row.kind === "radio" || row.kind === "submenu") &&
    row.disabled &&
    row.reason
      ? `, ${row.reason}`
      : "";
  return `${within ? `${within}: ` : ""}${row.label ?? ""}${mark}${why}`;
}

/** The open/close half of an `OpenState` that a trigger needs. */
interface OpenControl {
  open: () => boolean;
  set: (open: boolean, reason: OpenReason) => boolean;
}

/** What one open menu knows, for the keys that act on its innermost submenu and for the trigger. */
export interface Session {
  /** Closes the menu. A choice closes it as `item-press`. */
  close: (reason?: OpenReason) => void;
  /** Open levels, outermost first; the keys go to the last. */
  levels: Level[];
  /** The highlight was last moved by a key, not by the pointer. */
  keyboard: boolean;
  /** Closed in this turn: a Return that the menu took must not be taken again by the focused trigger. */
  justClosed: boolean;
  /** A row is pressed right now. */
  holding: boolean;
  /** How the menu last opened, and when: a press soon after a hover opening is not a close. */
  openedBy?: OpenReason;
  openedAt: number;
}

export function createSession(state: OpenControl): Session {
  const session: Session = {
    close: (reason = "item-press") => {
      session.justClosed = true;
      setTimeout(() => {
        session.justClosed = false;
      }, 0);
      state.set(false, reason);
    },
    levels: [],
    keyboard: false,
    justClosed: false,
    holding: false,
    openedAt: 0,
  };
  return session;
}

/** Opens the menu and remembers how, for `pressTrigger` and the hover close. */
export function openMenu(state: OpenControl, session: Session, reason: OpenReason) {
  if (!state.set(true, reason)) return;
  session.openedBy = reason;
  session.openedAt = Date.now();
}

/**
 * What a press on the trigger of a menu does. Return on a focused trigger presses it, not the menu's key: if the menu
 * took that Return and closed, the press is ignored, and while a key has the highlight the press chooses it. A press
 * within `PATIENT_CLICK_MS` of a hover opening keeps the menu open.
 */
export function pressTrigger(state: OpenControl, session: Session) {
  if (session.justClosed) return;
  if (!state.open()) {
    openMenu(state, session, "trigger-press");
    return;
  }
  if (session.keyboard) session.levels[session.levels.length - 1]?.activate();
  else if (session.openedBy !== "trigger-hover" || Date.now() - session.openedAt >= PATIENT_CLICK_MS)
    state.set(false, "trigger-press");
}

/**
 * The trigger lost the keyboard focus (Tab, or a click elsewhere): the menu closes with it, unless a row is being
 * pressed (a press can blur the trigger a moment before it lands).
 */
export function closeOnBlur(state: OpenControl, session: Session) {
  setTimeout(() => {
    if (state.open() && !session.holding) session.close("focus-out");
  }, 120);
}

/** One panel of a menu (the menu itself or a submenu), as the keys see it. */
interface Level {
  rows: () => MenuRow[];
  /** Rows that take no highlight: headings and dividers. */
  skip: () => boolean[];
  /** The labels through `fold`, for typing. */
  folded: () => string[];
  active: Signal<number>;
  /** How many rows a page key moves. */
  page: number;
  /** Moves the highlight; from a key it also brings the row into view and says it. */
  go: (index: number, byKey: boolean) => void;
  /** Return or Space: choose the highlighted row; a submenu opens with its first row highlighted. */
  activate: () => void;
  /** Right arrow. */
  enter: () => void;
  /** Left arrow: close this submenu. */
  leave?: () => void;
}

/** What a row's keycaps show: its accelerator letter, else its shortcut, both through `Keys` so they end on one edge. */
const rowKeys = (row: ItemRow): string | undefined => row.accelerator ?? row.shortcut;

/** The inside of a row: a column for icons when the panel has any, the label, the tick, the shortcut, the chevron of a submenu. */
function RowContent(props: { row: () => ItemRow | SubmenuRow; icons: boolean }) {
  const keys = () => (props.row().kind === "submenu" ? undefined : rowKeys(props.row() as ItemRow));
  const reason = () => (props.row().disabled ? props.row().reason : undefined);
  const tone = () => rowTone(props.row());
  return (
    <>
      <If when={props.icons}>
        <View class="size-4 items-center justify-center">
          <If when={props.row().icon}>{(name) => <Icon name={name()} size={14} tone={tone().icon} />}</If>
        </View>
      </If>
      {/* Sized by its text, and cut only when the popup is at its greatest width; the spacer pushes the tick and keycap right. */}
      <Text class={`line-clamp-1 min-w-0 shrink text-sm ${tone().text}`}>{props.row().label}</Text>
      <View class="min-w-0 flex-1" />
      <If when={isChecked(props.row())}>
        <Icon name="check" size={14} tone="primary" />
      </If>
      <If when={reason()}>{(text) => <Text class="shrink-0 text-xs text-muted-foreground">{text()}</Text>}</If>
      <If when={reason() ? undefined : keys()}>{(text) => <Keys keys={text()} tone="bare" />}</If>
      <If when={props.row().kind === "submenu"}>
        <Icon name="chevron-right" size={14} tone="muted-foreground" />
      </If>
    </>
  );
}

/** What every panel of one menu follows. */
interface Config {
  loop: boolean;
  /** The pointer moves the highlight. */
  hover: boolean;
  /** A choice list (a select's): rows hang like the trigger's text, typing skips disabled options. */
  choice: boolean;
}

/**
 * One panel: the rows of `rows()`. The highlight is one signal, moved by the pointer and by the keys alike. A row that
 * opens a submenu opens it after the pointer rests on it, and keeps it open while the pointer crosses the rows between
 * it and the submenu (`inTransit`). `within` names the submenu these rows are in, so "Done" in a menu is not
 * confused with another "Done". A panel taller than `max` scrolls: with many rows and no submenu it is a `List`
 * (the rows near the window exist, cells are recycled), else a `Scroll`. `viewport` is a height and a start offset
 * decided by the caller (a select laid over its trigger).
 */
function Panel(props: {
  rows: () => MenuRow[];
  session: Session;
  config: Config;
  max: number;
  within?: string;
  start?: "first" | "selected";
  /** The row drawn highlighted at first, over `start` (`MenuPreview`). */
  highlight?: number;
  viewport?: { height: number; scroll: number };
  onLeave?: () => void;
}) {
  const { session, config } = props;
  // A choice that closes the menu can remove what the rows were drawn from (a deleted record): from then on they stay as they were.
  let last: MenuRow[] = [];
  let folded: string[] | undefined;
  const rows = computed(() => {
    if (session.justClosed) return last;
    folded = undefined;
    last = props.rows();
    return last;
  });
  const skip = computed(() => rows().map((r) => r.kind === "label" || r.kind === "separator"));
  const offsets = computed(() => offsetsOf(rows().map(heightOf)));
  const first = rows();
  const content = offsets()[first.length];
  const height = props.viewport?.height ?? Math.min(content, props.max);
  const scrolls = content > height;
  const hasSubmenu = first.some((r) => r.kind === "submenu");
  const virtual = scrolls && !hasSubmenu && first.length > VIRTUAL_ROWS;
  const icons = first.some((r) => r.kind !== "label" && r.kind !== "separator" && !!r.icon);
  const selected = first.findIndex(isChecked);
  const scroll0 =
    props.viewport?.scroll ??
    (props.start === "selected" && selected >= 0
      ? snapScroll(offsets(), centerOffset(offsets(), selected, height), height, selected)
      : 0);
  const active = signal(
    props.highlight !== undefined
      ? props.highlight
      : props.start === "first"
        ? stepIndex(skip(), -1, 1, true)
        : props.start === "selected"
          ? selected
          : -1,
  );
  const open = signal(-1);
  const triggers: ViewRef[] = [];
  let opening: { row: number; timer: number } | undefined;
  /** Where the pointer last was on the row whose submenu is open or about to open. */
  let apex: Point = { x: 0, y: 0 };
  /** The open submenu's frame, once the core has placed it. */
  let frame: Bounds | undefined;
  let firstOnOpen = false;
  /** The row the open submenu hangs from, lifted by the popup's own border and padding so its first row lines up with the row that opened it. */
  const hangsFrom = signal<Bounds | undefined>(undefined);
  let list: ListRef | undefined;
  let scroll: ScrollRef | undefined;
  let offset = scroll0;

  const cancel = () => {
    if (opening) clearTimeout(opening.timer);
    opening = undefined;
  };
  const scrollTo = (y: number) => {
    offset = y;
    if (virtual) list?.scrollToOffset({ offset: y, animated: false });
    else scroll?.scrollTo({ y, animated: false });
  };
  const reveal = (index: number) => {
    if (!scrolls) return;
    const to = revealOffset(offsets(), index, offset, height);
    if (to !== undefined) scrollTo(to);
  };
  const show = (row: number, byKey: boolean) => {
    cancel();
    frame = undefined;
    firstOnOpen = byKey;
    hangsFrom.set(undefined);
    active.set(row);
    open.set(row);
    void triggers[row].measure().then((m) => {
      if (m && open() === row)
        hangsFrom.set({ origin: { x: m.pagePosition.x, y: m.pagePosition.y - POPUP_INSET }, size: m.bounds.size });
    });
  };
  const choose = (index: number, byKey: boolean) => {
    const row = rows()[index];
    if (!row || row.kind === "label" || row.kind === "separator" || row.disabled) return;
    if (row.kind === "submenu") {
      show(index, byKey);
      return;
    }
    row.select();
    if (row.closeOnClick) session.close("item-press");
  };
  const level: Level = {
    rows,
    skip,
    folded: () => (folded ??= rows().map((r) => fold(r.label ?? ""))),
    active,
    page: Math.max(1, Math.floor(height / ITEM_HEIGHT) - 1),
    go: (index, byKey) => {
      cancel();
      active.set(index);
      if (open() !== index) open.set(-1);
      if (!byKey) return;
      reveal(index);
      const row = rows()[index];
      if (row) announce(nameOf(row, props.within));
    },
    activate: () => {
      if (active() >= 0) choose(active(), true);
    },
    enter: () => {
      const row = rows()[active()];
      if (row?.kind === "submenu" && !row.disabled) show(active(), true);
    },
    leave: props.onLeave,
  };
  session.levels.push(level);
  cleanup(() => {
    cancel();
    session.levels.splice(session.levels.indexOf(level), 1);
  });

  const hover = (index: number, at?: Point) => {
    session.keyboard = false;
    const row = rows()[index];
    if (!row) return;
    const submenu = row.kind === "submenu";
    if (submenu && open() === index) {
      if (at) apex = at;
      if (config.hover) active.set(index);
      return;
    }
    if (open() >= 0 && frame && at && inTransit(apex, frame, at)) return;
    if (submenu && !row.disabled) {
      if (config.hover) active.set(index);
      if (at) apex = at;
      if (opening?.row === index) return;
      cancel();
      // Next to a submenu that is open, the next one takes its place at once: the pointer is already navigating.
      if (open() >= 0) show(index, false);
      else opening = { row: index, timer: setTimeout(() => show(index, false), OPEN_DELAY) };
      return;
    }
    cancel();
    open.set(-1);
    if (config.hover) active.set(index);
  };
  const leaveRow = (index: number) => {
    if (opening?.row === index) cancel();
    if (config.hover && active() === index && open() !== index) active.set(-1);
  };

  const rowView = (row: () => MenuRow, index: () => number) => {
    const item = () => row() as ItemRow | SubmenuRow;
    const submenu = () => row().kind === "submenu";
    const sub = () => row() as SubmenuRow;
    const danger = () => row().kind !== "submenu" && (row() as ItemRow).danger;
    const disabled = () => (item().disabled ? true : undefined);
    return (
      // A scrolling list leaves its rows room for the scroll bar, which would cover the highlight and the tick.
      <View class={scrolls ? "pr-2" : undefined}>
        <If when={row().kind === "separator"}>
          <View role="none" class="mx-1 my-1 h-px bg-border" />
        </If>
        <If when={row().kind === "label"}>
          <View class={`h-7 justify-end pb-1 ${config.choice ? "px-2" : "px-3"}`}>
            <Text role="header" class="line-clamp-1 text-xs font-medium text-muted-foreground">
              {row().label}
            </Text>
          </View>
        </If>
        <If when={row().kind !== "separator" && row().kind !== "label"}>
          <View
            ref={(node: ViewRef) => {
              triggers[index()] = node;
            }}
            role="menuitem"
            focusable={false}
            accessibilityLabel={nameOf(row(), props.within)}
            accessibilityHint={submenu() ? undefined : (item() as ItemRow).shortcut}
            // Keys move a highlight, not the focus: `selected` is how a screen reader follows it.
            accessibilityState={{
              disabled: disabled(),
              selected: active() === index(),
              expanded: submenu() ? open() === index() : undefined,
              checked: row().kind === "check" || row().kind === "radio" ? isChecked(row()) : undefined,
            }}
            onPress={() => choose(index(), false)}
            onPressDown={() => {
              session.holding = true;
            }}
            onPressUp={() => {
              session.holding = false;
            }}
            onMouseEnter={hasSubmenu ? undefined : () => hover(index())}
            onMouseMove={hasSubmenu ? (e: MouseEvent) => hover(index(), e.pagePosition) : undefined}
            onMouseLeave={() => leaveRow(index())}
            class={`${config.choice ? CHOICE_ITEM : ITEM} ${active() === index() ? (danger() && !disabled() ? "bg-destructive/10" : "bg-accent") : ""}`}
          >
            <RowContent row={item} icons={icons} />
          </View>
          <If when={submenu() && open() === index() ? hangsFrom() : undefined}>
            {(box) => (
              <Overlay
                anchor={box()}
                placement="right"
                align="start"
                role="menu"
                onPosition={(e) => {
                  frame = e.bounds;
                }}
                onCancel={() => open.set(-1)}
                style={{ minWidth: menuWidth(menuRows(sub().items)) }}
                class={POPUP}
              >
                <Panel
                  rows={() => menuRows(sub().items)}
                  session={session}
                  config={config}
                  max={props.max}
                  within={sub().label}
                  start={firstOnOpen ? "first" : undefined}
                  onLeave={() => open.set(-1)}
                />
              </Overlay>
            )}
          </If>
        </If>
      </View>
    );
  };

  if (virtual) {
    return (
      <List
        each={rows()}
        keyExtractor={(_row: MenuRow, i: number) => String(i)}
        estimatedItemSize={ITEM_HEIGHT}
        style={{ height }}
        contentOffset={{ y: scroll0 }}
        ref={(node: ListRef) => {
          list = node;
        }}
        onScroll={(e) => {
          offset = e.offset.y;
        }}
      >
        {(row, index) => rowView(row, index)}
      </List>
    );
  }
  const body = (
    <Each of={rows()} key="index">
      {(row, index) => rowView(row, index)}
    </Each>
  );
  if (!scrolls) return body;
  return (
    <Scroll
      style={{ height }}
      contentOffset={{ y: scroll0 }}
      ref={(node: ScrollRef) => {
        scroll = node;
      }}
      onScroll={(e) => {
        offset = e.offset.y;
      }}
    >
      {body}
    </Scroll>
  );
}

/**
 * The open menu: a popup against `anchor`. Up, Down, Home and End move the highlight (Page Up and Page Down a page), Right
 * and Left enter and leave a submenu, Return and Space choose, letters find a row by its label (`typeahead`), Escape closes
 * the innermost submenu and then the menu, and the trigger losing the focus (Tab) closes it. It also closes when the window
 * resizes and when its anchor moves (the trigger scrolled away): a popup left over other content is worse than none. Mounted
 * only while open, so its keys are bound only then.
 *
 * `over` is a trigger the selected row is laid over (a select's pop-up button look): the popup is as tall as the window
 * allows, scrolled so that row sits on the trigger, or under the trigger when that cannot be done.
 */
export function Surface(props: {
  rows: () => MenuRow[];
  session: Session;
  anchor: ViewRef;
  align?: "start" | "end";
  offset?: number;
  /** Which row starts highlighted: the first, or the one that is ticked (a choice list opens on its value). */
  start?: "first" | "selected";
  /** The popup is at least this wide (a choice list is as wide as its trigger). */
  minWidth?: number;
  over?: ViewRef;
  choice?: boolean;
  /** Whether Up on the first row goes to the last (and the other way round). Default true. */
  loop?: boolean;
  /** Whether the pointer moves the highlight. Default true. */
  highlightItemOnHover?: boolean;
  /** The pointer entered or left the popup (a menu a hover opened closes when it leaves). */
  onPopupHover?: { enter: () => void; leave: () => void };
}) {
  const { session } = props;
  session.keyboard = false;
  const config: Config = {
    loop: props.loop ?? true,
    hover: props.highlightItemOnHover ?? true,
    choice: !!props.choice,
  };
  const windowHeight = windowSize().height;
  const max = Math.max(ITEM_HEIGHT * 3, Math.min(MAX_ROWS_HEIGHT, windowHeight - 2 * MARGIN - CHROME));
  // A choice that closes the menu can remove what the rows were drawn from (a deleted record): from then on they stay as they were.
  let kept: MenuRow[] = [];
  const rowsOf = computed(() => (session.justClosed ? kept : (kept = props.rows())));
  const content0 = offsetsOf(rowsOf().map(heightOf)).at(-1) ?? 0;
  // A menu that cannot overflow either side is shown at once; a taller one (or a select laid over its trigger) waits for
  // the trigger's measure, so it is built once at its final height and never jumps.
  const waits = !!props.over || !surelyFits(Math.min(content0, max) + CHROME, windowHeight, props.offset ?? 0);
  // `undefined` while the trigger is measured, `null` when the list goes under it.
  const plan = signal<{ viewport: { height: number; scroll: number }; offset: number } | null | undefined>(
    waits ? undefined : null,
  );
  // The rows' height when the popup would not fit beside its trigger: a popup of this size was cut to the room it has.
  const capped = signal<number | undefined>(undefined);
  const fit = (m: { pagePosition: Point; bounds: Bounds }, gap: number) => {
    const content = offsetsOf(rowsOf().map(heightOf)).at(-1) ?? 0;
    const trigger = { top: m.pagePosition.y, bottom: m.pagePosition.y + m.bounds.size.height };
    const rows = fitRows(Math.min(content, max) + CHROME, roomAround(trigger, gap, windowHeight));
    if (rows !== undefined) capped.set(rows);
  };
  const over = props.over;
  if (!over) {
    // Measured after the first frame: a menu that fits (nearly all do) is never rebuilt.
    void props.anchor.measure().then((m) => {
      if (m) fit(m, props.offset ?? 0);
      if (plan() === undefined) plan.set(null);
    });
  }
  if (over) {
    const rows = rowsOf();
    const offsets = offsetsOf(rows.map(heightOf));
    const selected = rows.findIndex(isChecked);
    const row = selected >= 0 ? selected : rows.findIndex((r) => r.kind !== "label" && r.kind !== "separator");
    void over.measure().then((m) => {
      if (!m || row < 0) {
        plan.set(null);
        return;
      }
      const bottom = m.pagePosition.y + m.bounds.size.height;
      const aligned = alignSelected({
        target: m.pagePosition.y + m.bounds.size.height / 2,
        rowCenter: (offsets[row] + offsets[row + 1]) / 2,
        rowHeight: ITEM_HEIGHT,
        content: offsets[rows.length],
        max,
        // One point of slack: a popup that ends exactly at the edge can be put on the other side by rounding.
        area: { top: MARGIN + POPUP_INSET, bottom: windowHeight - MARGIN - POPUP_INSET - 1 },
      });
      if (!aligned) {
        fit(m, props.offset ?? 0);
        plan.set(null);
        return;
      }
      // The first row shows whole: the offset goes to a row boundary and the popup moves with it, so the chosen row stays on the trigger.
      const scroll = snapScroll(offsets, aligned.scroll, aligned.height, row);
      const lowest = MARGIN + POPUP_INSET - aligned.top;
      const highest = windowHeight - MARGIN - POPUP_INSET - 1 - aligned.height - aligned.top;
      const shift = scroll - aligned.scroll;
      const snapped = shift >= lowest && shift <= highest;
      plan.set({
        viewport: { height: aligned.height, scroll: snapped ? scroll : aligned.scroll },
        offset: aligned.top + (snapped ? shift : 0) - POPUP_INSET - bottom,
      });
    });
  }

  const top = () => session.levels[session.levels.length - 1];
  const move = (step: 1 | -1) => {
    const level = top();
    if (!level) return;
    session.keyboard = true;
    const next = stepIndex(level.skip(), level.active(), step, config.loop);
    if (next >= 0) level.go(next, true);
  };
  const edge = (step: 1 | -1) => {
    const level = top();
    if (!level) return;
    session.keyboard = true;
    const next = edgeIndex(level.skip(), step);
    if (next >= 0) level.go(next, true);
  };
  const page = (step: 1 | -1) => {
    const level = top();
    if (!level) return;
    session.keyboard = true;
    const next = pageIndex(level.skip(), level.active(), step, level.page);
    if (next >= 0) level.go(next, true);
  };
  let typing: Typing | undefined;
  let typingIn: Level | undefined;
  const type = (letter: string) => {
    const level = top();
    if (!level) return;
    if (typingIn !== level) typing = undefined;
    typingIn = level;
    const rows = level.rows();
    const skip = level.skip().map((s, i) => s || (config.choice && isItem(rows[i]) && (rows[i] as ItemRow).disabled));
    const found = typeahead(typing, letter, level.folded(), skip, level.active(), Date.now());
    typing = found.typing;
    if (found.index >= 0) {
      session.keyboard = true;
      level.go(found.index, true);
    }
  };
  const choose = () => {
    session.keyboard = true;
    top()?.activate();
  };
  keymap.bind({ down: () => move(1), up: () => move(-1) }, { when: "always", repeat: true });
  keymap.bind(
    {
      home: () => edge(1),
      end: () => edge(-1),
      pageup: () => page(-1),
      pagedown: () => page(1),
      right: () => top()?.enter(),
      left: () => top()?.leave?.(),
      enter: choose,
      // Tab is not bound: it moves the focus on in one press, and the trigger's blur closes the menu (`closeOnBlur`).
    },
    { when: "always" },
  );
  // A space after letters is part of the word; alone it chooses, like Return.
  // `when: "always"`: a menu opens over whatever has the keyboard (the message box), and while it is open its letters are its
  // own: an accelerator pressed there must run, not type into the field behind the menu.
  keymap.bind("space", () => (isTyping(typing, Date.now()) ? type(" ") : choose()), { when: "always" });
  const letter = (l: string) => {
    const level = top();
    const hit = level ? routeLetter(level.rows(), l, isTyping(typing, Date.now())) : undefined;
    if (!level || hit?.kind !== "accelerator") return type(l);
    typing = undefined;
    session.keyboard = true;
    level.go(hit.index, true);
    level.activate();
  };
  keymap.bind(Object.fromEntries(TYPING_KEYS.map((l) => [l, () => letter(l)])), { when: "always" });

  // A dialog opened from a menu item must not leave the menu floating under its scrim.
  const depth = dialogDepth();
  effect(() => {
    if (dialogDepth() > depth) session.close("imperative");
  });
  // The popup is placed once: a window that changes size no longer matches where it was laid.
  let sized = false;
  effect(() => {
    windowSize();
    if (sized) session.close("anchor-moved");
    sized = true;
  });
  let hung: Hung | undefined;
  const placed = (p: OverlayPosition) => {
    const next = anchorMoved(hung, p);
    hung = next.hung;
    if (next.moved) session.close("anchor-moved");
  };

  return (
    <If when={plan() !== undefined}>
      <Overlay
        anchor={props.anchor}
        placement="bottom"
        align={props.align ?? "start"}
        offset={plan()?.offset ?? props.offset ?? 0}
        margin={MARGIN}
        role="menu"
        onPressOutside={() => session.close("outside-press")}
        onCancel={() => session.close("escape-key")}
        onPosition={placed}
        onMouseEnter={props.onPopupHover?.enter}
        onMouseLeave={props.onPopupHover?.leave}
        style={
          props.minWidth ? { minWidth: props.minWidth } : props.choice ? undefined : { minWidth: menuWidth(rowsOf()) }
        }
        class={POPUP}
      >
        <If when={capped() === undefined}>
          <Panel
            rows={rowsOf}
            session={session}
            config={config}
            max={max}
            start={props.start}
            viewport={plan()?.viewport}
          />
        </If>
        <If when={capped() !== undefined}>
          <Panel
            rows={rowsOf}
            session={session}
            config={config}
            max={capped() ?? max}
            start={props.start}
            viewport={plan()?.viewport}
          />
        </If>
      </Overlay>
    </If>
  );
}

/**
 * A menu's panel drawn in place instead of in a popup, with the rows, width, surface and row look of the open menu: for a
 * lab or a spec page, because the host's window screenshot does not draw an overlay. `highlight` is the row drawn
 * highlighted, `maxHeight` the height past which it scrolls (384 by default, as the popup). Not for screens: a screen opens a
 * menu from its trigger (`ActionMenu`, `RowMenu`).
 */
export function MenuPreview(props: { entries: MenuEntry[]; highlight?: number; maxHeight?: number }) {
  const session = createSession(createOpenState({ defaultOpen: true }));
  const rows = () => menuRows(props.entries);
  return (
    <View style={{ width: menuWidth(rows()) }} class={`self-start ${POPUP}`}>
      <Panel
        rows={rows}
        session={session}
        config={{ loop: true, hover: true, choice: false }}
        max={props.maxHeight ?? MAX_ROWS_HEIGHT}
        highlight={props.highlight}
      />
    </View>
  );
}

/**
 * The "more" menu of a record: an icon button that opens actions, with submenus (`MenuGroup`), checkboxes, radios,
 * headings and dividers. Put the destructive action last, after a divider. Anything used daily also gets a visible
 * button: a menu hides it. `open` and `onOpenChange` make it controlled (`onOpenChange` may `cancel()` a change);
 * `openOnHover` also opens it when the pointer rests on the button for `delay` ms and closes it `closeDelay` ms after the
 * pointer left (a menu opened by a press does not close on leaving).
 */
export function ActionMenu(props: {
  label: string;
  entries: MenuEntry[];
  icon?: IconName;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
  openOnHover?: boolean;
  delay?: number;
  closeDelay?: number;
  loop?: boolean;
  highlightItemOnHover?: boolean;
  /** A 28-pt trigger, as the small buttons beside it (default 32). */
  small?: boolean;
}) {
  const state = createOpenState({
    open: () => props.open,
    defaultOpen: props.defaultOpen,
    onOpenChange: (o, c) => props.onOpenChange?.(o, c),
  });
  const session = createSession(state);
  const intent = createHoverIntent({
    delay: props.delay ?? 100,
    closeDelay: props.closeDelay ?? 0,
    isOpen: () => state.open() && session.openedBy === "trigger-hover",
    open: () => openMenu(state, session, "trigger-hover"),
    close: () => session.close("trigger-hover"),
  });
  effect(() => {
    if (!state.open()) intent.cancel();
    else if (props.disabled) state.set(false, "disabled");
  });
  cleanup(intent.cancel);
  let trigger: ViewRef | undefined;
  return (
    <View
      ref={(node: ViewRef) => {
        trigger = node;
      }}
    >
      <Tipped label={props.label}>
        {/* A view, not an `IconButton`: a `Button` reports no blur, and a menu must close when Tab leaves its trigger. */}
        <View
          role="button"
          accessibilityLabel={props.label}
          accessibilityState={{ expanded: state.open(), disabled: props.disabled || undefined }}
          onPress={() => {
            if (!props.disabled) pressTrigger(state, session);
          }}
          onBlur={() => closeOnBlur(state, session)}
          onMouseEnter={() => {
            if (props.openOnHover && !props.disabled) intent.enterTrigger();
          }}
          onMouseLeave={() => {
            if (props.openOnHover) intent.leaveTrigger(true);
          }}
          style={hoverTransition()}
          class={`${props.small ? "size-7" : "size-8"} items-center justify-center rounded-md hover:bg-accent active:bg-accent ${state.open() ? "bg-accent" : ""} ${props.disabled ? "opacity-50" : ""} ${FOCUS_RING}`}
        >
          <Icon name={props.icon ?? "ellipsis"} tone="muted-foreground" />
        </View>
      </Tipped>
      <If when={state.open()}>
        <Surface
          rows={() => menuRows(props.entries)}
          session={session}
          anchor={trigger!}
          align="end"
          offset={4}
          loop={props.loop}
          highlightItemOnHover={props.highlightItemOnHover}
          onPopupHover={{ enter: intent.enterPopup, leave: intent.leavePopup }}
        />
      </If>
    </View>
  );
}

/**
 * Right-click anywhere on `children` for the same actions as the row's `ActionMenu`: a shortcut, never the only way. The
 * menu opens where the pointer is and hangs from a point inside the row, so it travels with the row and closes when the
 * row scrolls (`anchor-moved`) instead of staying over other rows.
 */
export function RowMenu(props: {
  entries: MenuEntry[];
  children?: JSX.Element;
  open?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
}) {
  const at = signal<Point | undefined>(undefined);
  const state = createOpenState({ open: () => props.open, onOpenChange: (o, c) => props.onOpenChange?.(o, c) });
  const session = createSession(state);
  return (
    <View
      onContextMenu={(e) => {
        at.set(e.position);
        openMenu(state, session, "trigger-press");
      }}
    >
      {props.children}
      <If when={state.open() ? at() : undefined}>
        {(where) => {
          // One anchor per opening: a row that is never right-clicked pays for none.
          const point = signal<ViewRef | undefined>(undefined);
          return (
            <>
              <View
                ref={(node: ViewRef) => {
                  point.set(node);
                }}
                style={{ position: "absolute", left: where().x, top: where().y, width: 0, height: 0 }}
              />
              <If when={point()}>
                {(anchor) => <Surface rows={() => menuRows(props.entries)} session={session} anchor={anchor()} />}
              </If>
            </>
          );
        }}
      </If>
    </View>
  );
}
