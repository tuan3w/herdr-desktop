import { announce, cleanup, effect, keymap, signal } from "nsh";

/**
 * Keyboard model of a group of items that is one stop of Tab (a tab list, a radio group): the arrow keys move
 * between the items, as Base UI's composite does. This host cannot move the keyboard focus from code (`focus()` is for
 * inputs), so the focus stays on the group's host view and a virtual highlight moves, announced to screen readers
 * (the same split as `menu.tsx` and `combo.tsx`). The items are `focusable={false}` views that still take presses.
 */

export type Orientation = "horizontal" | "vertical" | "both";
export type Move = "next" | "previous" | "first" | "last";

/** The keys a group listens to while it has the focus: only the axis it lays out along, so the other arrows still scroll the page. */
export function keysOf(orientation: Orientation, homeEnd: boolean): [string, Move][] {
  const keys: [string, Move][] = [];
  if (orientation !== "vertical") keys.push(["left", "previous"], ["right", "next"]);
  if (orientation !== "horizontal") keys.push(["up", "previous"], ["down", "next"]);
  if (homeEnd) keys.push(["home", "first"], ["end", "last"]);
  return keys;
}

/**
 * The index a move reaches. `skip[i]` marks items the highlight does not stop on. From -1 (nothing highlighted) `next`
 * enters at the first item and `previous` at the last. Past either end it wraps when `loop`, else stays. -1 when no
 * item can be reached from nothing; otherwise `from` when nothing else can be.
 */
export function stepIndex(skip: readonly boolean[], from: number, move: Move, loop: boolean): number {
  const count = skip.length;
  if (move === "first" || (move === "next" && from < 0)) return skip.findIndex((s) => !s);
  if (move === "last" || (move === "previous" && from < 0)) return skip.lastIndexOf(false);
  const step = move === "next" ? 1 : -1;
  for (let k = 1; k <= count; k++) {
    let i = from + step * k;
    if (i < 0 || i >= count) {
      if (!loop) return from;
      i = ((i % count) + count) % count;
    }
    if (!skip[i]) return i;
  }
  return from;
}

/** What a group asks of each item it holds. */
export interface RovingItem {
  label: () => string;
  disabled: () => boolean;
  /** Selected tab, checked radio. */
  current: () => boolean;
  activate: () => void;
}

export interface RovingOptions {
  /** Default `both`: every arrow moves, as Base UI's radio group. */
  orientation?: Orientation;
  /** Wrap past the ends (default true). */
  loop?: boolean;
  /** Home and End go to the first and last item. */
  homeEnd?: boolean;
  /** Disabled items are passed over (default true). A tab list keeps them reachable and refuses to activate them. */
  skipDisabled?: boolean;
  /** Reaching an item activates it (radios; tabs with `activateOnFocus`). Otherwise Space (and Enter) activate the highlighted one. */
  activateOnMove: () => boolean;
  /** Keys that activate the highlighted item. A radio is chosen with Space only; a tab with either. */
  activateKeys: readonly ("space" | "enter")[];
}

const SAYS_DISABLED = "unavailable";
const SAYS_CURRENT = "selected";

/** What an item reads from its group. */
export interface RovingMark {
  /** The host view has the focus and the highlight is on this item. */
  ring: () => boolean;
  /** The highlight is on this item while it is not the current one (a tab reached by arrow, not yet chosen). */
  lit: () => boolean;
}

export interface Roving {
  focus: { onPress: () => void; onFocus: () => void; onBlur: () => void };
  add: (item: RovingItem) => RovingMark;
}

/**
 * One group. Put `focus` on the host view (a view with `onPress`, `onFocus`, `onBlur`: it is the one stop of Tab) and
 * call `add` once per item while the item is made; the item reads `ring()` to draw its focus ring and `lit()` to show
 * the highlight when it is not the current item. The keys are bound only while the host view has the focus.
 */
export function createRoving(options: RovingOptions): Roving {
  const items: RovingItem[] = [];
  const focused = signal(false);
  const lit = signal<RovingItem | undefined>(undefined);
  const skip = options.skipDisabled ?? true;
  const loop = options.loop ?? true;
  const keys = keysOf(options.orientation ?? "both", options.homeEnd ?? false);

  /** The item a key moves from and Space acts on: the highlight, else the current item, else the first that can be reached. */
  const landing = (): RovingItem | undefined =>
    lit() ?? items.find((i) => i.current() && !(skip && i.disabled())) ?? items.find((i) => !(skip && i.disabled()));

  const go = (move: Move) => {
    const from = landing();
    const at = from ? items.indexOf(from) : -1;
    const to = stepIndex(
      items.map((i) => skip && i.disabled()),
      at,
      move,
      loop,
    );
    if (to < 0 || to === at) return;
    const target = items[to];
    const refused = target.disabled();
    if (options.activateOnMove() && !refused) target.activate();
    else lit.set(target);
    announce(
      [target.label(), refused ? SAYS_DISABLED : "", target.current() ? SAYS_CURRENT : ""].filter(Boolean).join(", "),
    );
  };

  const activate = () => {
    const target = landing();
    if (target && !target.disabled() && !target.current()) target.activate();
  };

  effect(() => {
    if (!focused()) return;
    const offKeys = keymap.bind(Object.fromEntries(keys.map(([key, move]) => [key, () => go(move)])), { repeat: true });
    const offActivate = keymap.bind(Object.fromEntries(options.activateKeys.map((key) => [key, activate])));
    return () => {
      offKeys();
      offActivate();
    };
  });

  return {
    focus: {
      onPress: () => {},
      onFocus: () => focused.set(true),
      onBlur: () => {
        focused.set(false);
        lit.set(undefined);
      },
    },
    add(item) {
      items.push(item);
      cleanup(() => {
        items.splice(items.indexOf(item), 1);
        if (lit() === item) lit.set(undefined);
      });
      return {
        /** The host view has the focus and the highlight is on this item. */
        ring: () => focused() && landing() === item,
        /** The highlight is on this item while it is not the current one (a tab reached by arrow, not yet chosen). */
        lit: () => lit() === item && !item.current(),
      };
    },
  };
}
