import { announce, cleanup, computed, effect, keymap, List, type Signal, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import type { Bounds, InputRef, ListRef, ViewRef } from "nsh/types";
import { hoverTransition } from "../../lib/motion";
import { timing } from "../../lib/perf";
import {
  type AutoHighlight,
  type AutocompleteMode,
  type Choice,
  chipAfterRemoval,
  chipStep,
  contentHeight,
  createRefiner,
  entryOf,
  filterQuery,
  filtersByText,
  foldFast,
  found,
  groupChoices,
  type HighlightReason,
  ids,
  type Job,
  initialHighlight,
  inlineText,
  type Layout,
  layout,
  nextHighlight,
  pageHighlight,
  queryKey,
  queryWords,
  reconcileTyped,
  removeAt,
  revealOffset,
  ROW_H,
  startJob,
  stepJob,
  toggleValue,
  typingOpens,
  wordProbe,
} from "./combo-rules";
import { openOnDown } from "./core";
import { dialogDepth } from "./dialog-stack";
import { INPUT_CLASS, Labeled, type Option } from "./fields";
import { Clipped } from "./hint";
import { Icon } from "./icon";
import { Spinner } from "./loading";
import { createOpenState, type OpenChange, type OpenReason } from "./popup";
import { Positioner } from "./positioner";

/**
 * `Combobox` and `Autocomplete`, ported from Base UI's Combobox and Autocomplete. Both are an input that keeps the
 * keyboard focus and a list that is never focused: the highlight is a position moved by Up and Down (and the pointer),
 * announced to screen readers, and Enter picks it. They share one engine: the options are scanned in time slices when
 * typing, the list is a recycled `List` (so 50,000 options cost as much as 50), and nothing is built while closed.
 * `design/combobox.md` has the rules.
 */

const POPUP = "rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md";
const COMBOBOX_ROWS = 7;
const AUTOCOMPLETE_ROWS = 8;
const PAGE = COMBOBOX_ROWS;
/** Width of a list whose rows carry a second text (a session's agent after its title): room for both, not the field's. */
const HINT_WIDTH = 360;
/** How long a scan slice may hold the thread: a frame is 8 ms, and the same thread paints. */
const SLICE_MS = 3;
/** Pressing a row blurs the input before the press lands: a blur closes only once this long has passed with no press held. */
const BLUR_MS = 120;
/** How long the count of results waits for typing to settle before a screen reader is told. */
const SAY_MS = 300;
const INVALID = "border-destructive hover:border-destructive focus:border-destructive focus:outline-destructive/30";
const CHIPS_SHOWN = 24;
/** What a list that is closing reads while its last frame is still drawn. */
const NONE: Layout = layout([], undefined, -1);

/** The thread time of one change of the list: what a keystroke costs before the next frame (the dev panel shows it). */
const listTime = timing("combobox.list", "Combobox: list per keystroke", { warn: 8, bad: 50 });

export type ComboFilter<T> = null | ((option: T, query: string) => boolean);

export interface HighlightDetails {
  reason: HighlightReason;
  /** Position in the list as shown (after filtering and grouping), -1 for none. */
  index: number;
}

/** What is scanned, and what it shows. One per list; builds nothing until the list is open. */
function createModel(o: {
  items: () => readonly Choice[];
  query: () => string;
  active: () => boolean;
  filter: () => ComboFilter<Choice> | undefined;
  limit: () => number;
  hideExact: () => boolean;
  onPublish: (l: Layout, changed: boolean) => void;
}) {
  const result = signal<Layout | undefined>(undefined);
  const pending = signal(false);
  const refiner = createRefiner();
  const groups = computed(() => groupChoices(o.items()));
  let timer: number | undefined;
  let scanned: readonly Choice[] | undefined;
  let lastKey: string | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  cleanup(stop);

  const publish = (order: readonly number[], key: string) => {
    const l = layout(order, groups(), o.limit());
    const changed = key !== lastKey;
    lastKey = key;
    pending.set(false);
    result.set(l);
    o.onPublish(l, changed);
  };

  /** Runs the scan in slices until it is done; the first slice runs now, so a short list answers in the keystroke's own turn. */
  const scan = (job: Job, done: (job: Job) => void) => {
    const step = () => {
      timer = undefined;
      if (stepJob(job, SLICE_MS)) done(job);
      else {
        pending.set(true);
        timer = setTimeout(() => listTime.time(step), 0);
      }
    };
    step();
  };

  const run = () => {
    stop();
    const list = o.items();
    const query = o.query();
    const filter = o.filter();
    if (list !== scanned) {
      refiner.reset();
      scanned = list;
    }
    const custom = typeof filter === "function" ? filter : undefined;
    const words = custom ? [] : queryWords(query);
    if (filter === null || (custom ? query.trim() === "" : words.length === 0)) {
      publish(ids(list.length), "");
      return;
    }
    const exact = o.hideExact() ? foldFast(query.trim()) : undefined;
    const show = (order: readonly number[], key: string) => publish(exact === undefined ? order : order.filter((i) => entryOf(list[i]).lead !== exact), key);
    if (custom) {
      scan(startJob(list.length, (i) => (custom(list[i], query) ? 1 : 0)), (job) => show(found("", job).order, `\u0000${query}`));
      return;
    }
    const key = queryKey(words);
    const known = refiner.lookup(key);
    if (known.exact) {
      show(known.exact.order, key);
      return;
    }
    scan(startJob(list.length, wordProbe(words, (i) => list[i]), known.source), (job) => {
      const answer = found(key, job);
      refiner.keep(answer);
      show(answer.order, key);
    });
  };

  effect(() => {
    if (!o.active()) {
      stop();
      refiner.reset();
      scanned = undefined;
      lastKey = undefined;
      pending.set(false);
      result.set(undefined);
      return;
    }
    o.items();
    o.query();
    o.filter();
    o.limit();
    o.hideExact();
    untracked(() => listTime.time(run));
  });

  const choiceAt = (pos: number): Choice | undefined => {
    const l = result();
    return l === undefined ? undefined : o.items()[l.order[pos]];
  };
  return {
    layout: () => result(),
    ready: () => result() !== undefined,
    count: () => result()?.order.length ?? 0,
    pending: () => pending(),
    choiceAt,
    itemAt: (pos: number): number => result()?.order[pos] ?? -1,
  };
}

/** What the list reads of the scan. */
interface Model {
  layout: () => Layout | undefined;
  ready: () => boolean;
  count: () => number;
  pending: () => boolean;
  choiceAt: (pos: number) => Choice | undefined;
  itemAt: (pos: number) => number;
}

/** The highlight: a position in the list as shown, moved by keys and by the pointer, kept in view. */
function createNav(m: Model, o: { loop: () => boolean; escape: () => boolean; viewport: () => number; announceRow: (c: Choice) => string; picked: (c: Choice) => boolean; onHighlight: (pos: number, reason: HighlightReason) => void }): Nav {
  const active = signal(-1);
  let reason: HighlightReason = "none";
  let list: ListRef | undefined;
  let scrollTop = 0;
  const disabled = (p: number) => m.choiceAt(p)?.disabled === true;
  const scrollTo = (offset: number) => {
    scrollTop = offset;
    list?.scrollToOffset({ offset, animated: false });
  };
  const set = (pos: number, why: HighlightReason, reveal = why === "keyboard") => {
    if (pos === untracked(active) || (pos >= 0 && disabled(pos))) return;
    reason = why;
    active.set(pos);
    const l = m.layout();
    if (reveal && pos >= 0 && l) {
      const offset = revealOffset(l, pos, scrollTop, o.viewport());
      if (offset !== undefined) scrollTo(offset);
    }
    o.onHighlight(pos, why);
    // The focus stays in the input, so a screen reader hears the highlight only if told.
    const c = pos >= 0 ? m.choiceAt(pos) : undefined;
    if (why === "keyboard" && c) announce(o.announceRow(c));
  };
  return {
    active: () => active(),
    reason: () => reason,
    set,
    clear: () => set(-1, "none"),
    move: (dir: 1 | -1) => set(nextHighlight(m.count(), untracked(active), dir, { loop: o.loop(), escape: o.loop() && o.escape(), disabled }), "keyboard"),
    page: (dir: 1 | -1) => set(pageHighlight(m.count(), untracked(active), dir, PAGE, disabled), "keyboard"),
    /** The list was made again for a new query or new options. */
    published(l: Layout, changed: boolean, fresh: () => number) {
      if (changed) {
        scrollTo(0);
        set(fresh(), "none", false);
      } else if (untracked(active) < 0 || untracked(active) >= l.order.length) set(fresh(), "none", false);
    },
    attach(node: ListRef | undefined) {
      list = node;
    },
    scrolled(offset: number) {
      scrollTop = offset;
    },
    reveal() {
      const l = m.layout();
      const pos = untracked(active);
      if (!l || pos < 0) return;
      const offset = revealOffset(l, pos, scrollTop, o.viewport());
      if (offset !== undefined) scrollTo(offset);
    },
    initialOffset: (viewport: number) => {
      const l = m.layout();
      const pos = untracked(active);
      const offset = l && pos >= 0 ? (revealOffset(l, pos, 0, viewport) ?? 0) : 0;
      scrollTop = offset;
      return offset;
    },
    isPointer: () => reason === "pointer",
    picked: o.picked,
  };
}

/** The highlight, as the list and the field use it. */
interface Nav {
  active: () => number;
  reason: () => HighlightReason;
  set: (pos: number, why: HighlightReason, reveal?: boolean) => void;
  clear: () => void;
  move: (dir: 1 | -1) => void;
  page: (dir: 1 | -1) => void;
  /** The list was made again: `changed` is a new query (or a new opening), else only new options. */
  published: (l: Layout, changed: boolean, fresh: () => number) => void;
  attach: (node: ListRef | undefined) => void;
  scrolled: (offset: number) => void;
  reveal: () => void;
  /** Where a list that has just opened starts: the highlighted row in view, with its group's heading. */
  initialOffset: (viewport: number) => number;
  isPointer: () => boolean;
  picked: (c: Choice) => boolean;
}

interface CoreOptions {
  items: () => readonly Choice[];
  query: () => string;
  filter: () => ComboFilter<Choice> | undefined;
  limit: () => number;
  hideExact: () => boolean;
  auto: () => AutoHighlight;
  /** Indices (into the items) of what is chosen: the list opens on the first. */
  chosen: () => readonly number[];
  loop: () => boolean;
  inline: () => boolean;
  disabled: () => boolean;
  rows: number;
  open?: () => boolean | undefined;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
  /** After a close: put the field's own state back (what was typed, a half-finished completion). */
  closed: () => void;
  onHighlight: (choice: Choice | undefined, reason: HighlightReason, pos: number) => void;
  loading: () => boolean;
  empty: () => string | undefined;
}

const rowName = (c: Choice, picked: boolean) => `${c.title}${c.hint ? `, ${c.hint}` : ""}${picked ? ", selected" : ""}${c.disabled ? ", disabled" : ""}`;

/** What `Combobox` and `Autocomplete` share: the open state, the list, the highlight, the focus rules, the keys. */
function createCore(o: CoreOptions, picked: (c: Choice) => boolean): Core {
  const state = createOpenState({ open: o.open, defaultOpen: o.defaultOpen, onOpenChange: o.onOpenChange });
  const focused = signal(false);
  const composing = signal(false);
  const holding = signal(false);
  const width = signal(0);
  let anchor: ViewRef | undefined;
  let blurTimer: number | undefined;
  let saidTimer: number | undefined;
  let laidOut = false;
  let resized = false;
  /** What the filter was asked when a composition began: half-composed text must not narrow the list. */
  const frozen = signal("");
  cleanup(() => {
    clearTimeout(blurTimer);
    clearTimeout(saidTimer);
  });

  const visible = () => o.inline() || (state.open() && !o.disabled());
  const viewport = signal(0);
  const model: Model = createModel({
    items: o.items,
    query: o.query,
    active: visible,
    filter: o.filter,
    limit: o.limit,
    hideExact: o.hideExact,
    onPublish: (l, changed) => nav.published(l, changed, fresh),
  });
  const disabledAt = (p: number) => model.choiceAt(p)?.disabled === true;
  const fresh = () => {
    const l = model.layout();
    if (!l) return -1;
    const items = o.items();
    const chosen: number[] = [];
    for (const i of o.chosen()) {
      const p = l.order.indexOf(i);
      if (p >= 0 && items[i] !== undefined) chosen.push(p);
    }
    return initialHighlight({ count: l.order.length, chosen, typing: o.query().trim() !== "", auto: o.auto(), disabled: disabledAt });
  };
  const nav: Nav = createNav(model, {
    loop: o.loop,
    escape: () => o.auto() === false,
    viewport: () => viewport(),
    announceRow: (c) => rowName(c, picked(c)),
    picked,
    onHighlight: (pos, reason) => o.onHighlight(pos >= 0 ? model.choiceAt(pos) : undefined, reason, pos),
  });

  const show = (reason: OpenReason) => !o.disabled() && !o.inline() && state.set(true, reason);
  const hide = (reason: OpenReason) => !o.inline() && state.set(false, reason);
  // A dialog opened from outside this list (a menu item, a shortcut) must not leave it floating under the scrim. A list
  // inside a dialog starts at that dialog's depth, which only a dialog above it raises.
  let openedDepth = 0;
  effect(() => {
    if (state.open()) openedDepth = untracked(dialogDepth);
  });
  effect(() => {
    if (dialogDepth() > openedDepth && untracked(state.open)) untracked(() => state.set(false, "imperative"));
  });

  // Whatever closes the list (a pick, Escape, an owner's `open={false}`), the field returns to its resting state.
  let wasOpen = state.open();
  effect(() => {
    const now = state.open();
    if (wasOpen && !now) untracked(() => {
      nav.clear();
      composing.set(false);
      o.closed();
    });
    wasOpen = now;
  });
  effect(() => {
    if (o.disabled() && state.open()) untracked(() => state.set(false, "disabled"));
  });

  // Up and Down move the highlight of an open list; only the newest binding of a key runs, so this exists only while
  // it is needed. Not while composing: those keys choose among an input method's candidates.
  const navigable = computed(() => visible() && !composing() && model.count() > 0);
  effect(() => {
    if (!navigable()) return;
    return keymap.bind({ down: () => nav.move(1), up: () => nav.move(-1), pagedown: () => nav.page(1), pageup: () => nav.page(-1) }, { when: "always", repeat: true });
  });
  // Down opens the list of a focused field; once it is open the list's own Down moves through it.
  openOnDown(
    () => focused() && !state.open() && !o.inline() && !o.disabled() && !composing(),
    () => show("list-navigation"),
  );

  // What the list holds changes as the user types, away from where a screen reader is reading.
  effect(() => {
    if (!visible() || !model.ready()) return;
    const count = model.count();
    const text = o.loading() ? "Loading…" : count > 0 ? `${count} results` : o.empty();
    clearTimeout(saidTimer);
    if (text) saidTimer = setTimeout(() => announce(text), SAY_MS);
  });

  const blurSoon = () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (!holding() && !focused()) hide("focus-out");
    }, BLUR_MS);
  };

  return {
    state,
    visible,
    focused,
    composing,
    frozen,
    holding,
    width,
    model,
    nav,
    show,
    hide,
    viewport,
    setAnchor(node: ViewRef) {
      anchor = node;
    },
    anchor: () => anchor,
    /** The field's view moved or changed size. */
    laid({ bounds }: { bounds: Bounds }) {
      laidOut = true;
      width.set(bounds.size.width);
    },
    /** The overlay was placed. */
    placed() {
      // A field that grows (chips wrapping) moves the edge of its own list: that is not a scroll.
      resized = laidOut;
      laidOut = false;
    },
    /** The field moved with a scroll: a list left behind must not float over other things. */
    anchorMoved() {
      if (!resized) hide("anchor-moved");
    },
    /** A press that starts on a row or a field control: the input loses the focus to it, which must not close the list. */
    hold: { down: () => holding.set(true), up: () => {
      holding.set(false);
      if (!focused()) blurSoon();
    } },
    blurSoon,
    cancelBlur: () => clearTimeout(blurTimer),
    rows: o.rows,
    lit: () => !o.inline() || focused(),
  };
}

/** What `createCore` hands to the field and the list. */
interface Core {
  state: { open: () => boolean; set: (open: boolean, reason: OpenReason) => boolean };
  visible: () => boolean;
  focused: Signal<boolean>;
  composing: Signal<boolean>;
  /** What the filter was asked when a composition began. */
  frozen: Signal<string>;
  holding: Signal<boolean>;
  width: Signal<number>;
  model: Model;
  nav: Nav;
  show: (reason: OpenReason) => boolean;
  hide: (reason: OpenReason) => boolean;
  viewport: Signal<number>;
  setAnchor: (node: ViewRef) => void;
  anchor: () => ViewRef | undefined;
  laid: (e: { bounds: Bounds }) => void;
  placed: () => void;
  anchorMoved: () => void;
  hold: { down: () => void; up: () => void };
  blurSoon: () => void;
  cancelBlur: () => void;
  rows: number;
  /** Whether the highlight is drawn: always, except in an inline list whose field has lost the focus. */
  lit: () => boolean;
}

/** One row of the list, recycled: reads its position as an accessor and keeps no state of its own. */
function Row(props: { pos: () => number; core: Core; picked: (c: Choice) => boolean; onPick: (pos: number) => void }) {
  const { core } = props;
  const choice = () => core.model.choiceAt(props.pos());
  // An inline list is on the page whether or not the field has the focus: its highlight shows only while it does.
  const current = () => core.nav.active() === props.pos() && core.lit();
  const chosen = () => {
    const c = choice();
    return c !== undefined && props.picked(c);
  };
  return (
    // Not a Tab stop: the focus stays in the input, so one Tab leaves the field instead of walking the rows.
    <View
      role="button"
      focusable={false}
      disabled={choice()?.disabled}
      onPress={() => props.onPick(props.pos())}
      onMouseEnter={() => core.nav.set(props.pos(), "pointer")}
      accessibilityState={{ selected: current(), disabled: choice()?.disabled }}
      accessibilityLabel={choice() ? rowName(choice()!, chosen()) : ""}
      class={`h-8 flex-row items-center gap-2 rounded-md px-2 ${current() ? "bg-accent" : ""} ${choice()?.disabled ? "opacity-50" : ""}`}
    >
      <Clipped class="max-w-[70%] shrink-0 text-sm text-popover-foreground">{choice()?.title ?? ""}</Clipped>
      <View class="min-w-0 flex-1">
        <If when={choice()?.hint}>
          <Clipped class="text-xs text-muted-foreground">{choice()?.hint}</Clipped>
        </If>
      </View>
      <If when={chosen()}>
        <Icon name="check" size={14} tone="primary" />
      </If>
    </View>
  );
}

/** The list of a combobox: a recycled `List` of rows and group headings, or the one line that says why there are none. */
function Rows(props: { core: Core; picked: (c: Choice) => boolean; onPick: (pos: number) => void; empty?: string; loading: boolean }) {
  const { core } = props;
  const l = () => core.model.layout() ?? NONE;
  const height = () => Math.min(contentHeight(l()), core.rows * ROW_H);
  effect(() => core.viewport.set(height()));
  const message = () => (props.loading ? "Loading…" : props.empty);
  const start = untracked(() => core.nav.initialOffset(height()));
  return (
    <View
      onTouchStartCapture={core.hold.down}
      onTouchEndCapture={core.hold.up}
      onTouchCancelCapture={core.hold.up}
      onMouseLeave={() => {
        if (core.nav.isPointer()) core.nav.clear();
      }}
    >
      <If
        when={core.model.count() > 0}
        else={
          <View class="h-8 flex-row items-center gap-2 px-2">
            <If when={props.loading}>
              <Spinner size={14} tone="muted-foreground" />
            </If>
            <Text class="text-sm text-muted-foreground">{message() ?? ""}</Text>
          </View>
        }
      >
        <List
          each={l().rows}
          estimatedItemSize={ROW_H}
          contentOffset={{ y: start }}
          keyboardShouldPersistTaps="always"
          accessibilityLabel={`${core.model.count()} results`}
          style={{ height: height() }}
          ref={(node: ListRef) => core.nav.attach(node)}
          onScroll={(e) => core.nav.scrolled(e.offset.y)}
        >
          {(row) => (
            <If
              when={row() >= 0}
              else={
                <View class="h-7 justify-end px-2 pb-1">
                  <Text class="text-xs font-medium text-muted-foreground">{l().names[-row() - 1]}</Text>
                </View>
              }
            >
              <Row pos={row} core={core} picked={props.picked} onPick={props.onPick} />
            </If>
          )}
        </List>
      </If>
      <If when={core.model.layout()?.hidden}>
        <Text class="px-2 pb-1 pt-2 text-xs text-muted-foreground">{`${core.model.layout()?.hidden} more results: type to filter.`}</Text>
      </If>
    </View>
  );
}

/**
 * The list under a field: an overlay against the field (so the field keeps the focus and the list is in no one's Tab
 * order: a `Popover` makes its trigger a Tab stop of its own), or, `inline`, a box in the page. A press outside
 * closes it, Escape too.
 */
function ListPopup(props: { core: Core; width: number; inline: boolean; picked: (c: Choice) => boolean; onPick: (pos: number) => void; empty?: string; loading: boolean; onClose: (reason: OpenReason) => void }) {
  const body = () => <Rows core={props.core} picked={props.picked} onPick={props.onPick} empty={props.empty} loading={props.loading} />;
  return (
    <If when={props.core.model.ready() && (props.core.model.count() > 0 || props.loading || props.empty !== undefined)}>
      {props.inline ? (
        <View class={`mt-1 ${POPUP}`}>{body()}</View>
      ) : (
        <Positioner
          anchor={props.core.anchor()}
          side="bottom"
          align="start"
          offset={4}
          margin={8}
          onPressOutside={() => props.onClose("outside-press")}
          onCancel={() => props.onClose("escape-key")}
          onPosition={props.core.placed}
          onAnchorMoved={props.core.anchorMoved}
          class={`w-[${Math.round(props.width)}px] ${POPUP}`}
        >
          {body()}
        </Positioner>
      )}
    </If>
  );
}

export interface ComboOption<T extends string> extends Option<T> {
  /** Secondary text after the title, also searched (an agent's machine after a session title). */
  hint?: string;
  /** Options of one group sit under its heading, in the order groups first appear; options without one come first. */
  group?: string;
  /** Not pickable and skipped by the arrow keys. */
  disabled?: boolean;
  /** Searched, never shown. */
  keywords?: string;
}

interface ComboShared<T extends string> {
  label?: string;
  /** The input's accessible name when it has no visible `label` (make it specific where the same combobox repeats). */
  name?: string;
  /** Shown in the input while nothing is chosen. */
  placeholder?: string;
  /** Focuses the input when it appears (the first field of a dialog). */
  autoFocus?: boolean;
  items: ComboOption<T>[];
  /** What the list says when nothing matches. */
  empty?: string;
  small?: boolean;
  error?: string;
  hint?: string;
  reserve?: boolean;
  /** Ignores presses and keys, and closes the list. */
  disabled?: boolean;
  /** The list opens and can be browsed; nothing can be picked, cleared or removed. */
  readOnly?: boolean;
  required?: boolean;
  /** Draws the field as in error (an `error` text does it too). */
  invalid?: boolean;
  /** Controlled open state; `onOpenChange` may call `change.cancel()` (a multiple choice that stays open after a pick). */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
  /** Which row is highlighted by itself: `"always"` (default here: the chosen row, else the first), `true` (the first after typing), `false` (none until a key moves it). */
  autoHighlight?: boolean | "always";
  /** A press on the input opens the list (default true). */
  openOnInputClick?: boolean;
  /** The list is part of the page, always open, instead of floating under the field. */
  inline?: boolean;
  /** Most rows shown; the best matches stay and the list says how many were left out. */
  limit?: number;
  /** Your own matching (fuzzy, by a field): `query` is what was typed. `null`: the items are already filtered (a search the owner runs: see `onInputChange` and `loading`). */
  filter?: ComboFilter<ComboOption<T>>;
  /** The items are on their way: the list says so (and a screen reader hears it) instead of "no results". */
  loading?: boolean;
  /** The text of the field changed: `type` (the user typed), `reset` (it went back to the chosen title). */
  onInputChange?: (text: string, reason: "type" | "reset") => void;
  onItemHighlighted?: (option: ComboOption<T> | undefined, details: HighlightDetails) => void;
  /** The text of an option in the input and in a chip (default its title: a session may show only its title where the list shows its machine too). */
  itemToString?: (option: ComboOption<T>) => string;
  /** Up past the first row and Down past the last wrap (default true; the input sits between them while an `autoHighlight` is off). */
  loopFocus?: boolean;
  /** The highlight stays on a row when the pointer leaves the list (default: it clears). */
  keepHighlight?: boolean;
}

export type ComboboxProps<T extends string> = ComboShared<T> &
  (
    | {
        multiple?: false;
        value: T | "";
        onChange: (v: T) => void;
        /** Shows a clear button while something is chosen; it calls this. Emptying the field by typing calls it too. */
        onClear?: () => void;
      }
    | {
        multiple: true;
        value: T[];
        onChange: (v: T[]) => void;
        /** Shows a button that removes every chip (`onChange([])`). */
        clear?: boolean;
        /** Chips drawn at most (the rest as `+N`); every value is still chosen. */
        maxChips?: number;
      }
  );

/** The items as the engine reads them: built once per change of the owner's list (an owner's `.map` is read once, here). */
function indicesOf(items: readonly Choice[], values: readonly string[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) {
    const at = items.findIndex((c) => c.value === values[0]);
    return at < 0 ? [] : [at];
  }
  const want = new Set(values);
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) if (want.has(items[i].value)) out.push(i);
  return out;
}

/**
 * One value, or several, out of a long set, found by typing: an input that shows the chosen title (or, with
 * `multiple`, a chip for each value), with the list under it and a chevron to open it. The value is always one of
 * `items` (a fixed short set is a `SelectField`; free text with suggestions is an `Autocomplete`). The input keeps the
 * keyboard focus the whole time. Typing filters (accents and case ignored; every word must be in the title, the hint or
 * the keywords); Down opens; Up and Down move the highlight, Enter picks it, Escape closes and puts the chosen title
 * back; a press on the field opens the list. In a `multiple` field Backspace in the empty input removes the last chip,
 * Left from the start of the input walks the chips (Delete removes one) and a pick toggles. 50,000 items are fine.
 */
export function Combobox<T extends string>(props: ComboboxProps<T>) {
  const multiple = () => props.multiple === true;
  const items = computed<readonly Choice[]>(() => props.items);
  const values = computed<readonly string[]>(() => {
    const v = props.value as T | "" | T[];
    return Array.isArray(v) ? v : v ? [v] : [];
  });
  const chosenIndices = computed(() => indicesOf(items(), values()));
  const chosenSet = computed(() => new Set(values()));
  const optionAt = (i: number) => items()[i] as ComboOption<T> | undefined;
  const textOf = (c: Choice) => (props.itemToString ? props.itemToString(c as ComboOption<T>) : c.title);
  const title = () => (multiple() ? "" : (chosenIndices().map((i) => textOf(items()[i]))[0] ?? ""));
  const hasHint = computed(() => items().some((c) => c.hint));

  /** What the user typed since focusing; `undefined` while the input shows the chosen title. */
  const typed = signal<string | undefined>(undefined);
  const caretAtStart = signal(true);
  const chipCursor = signal(-1);
  let field: InputRef | undefined;
  /** The pointer is over the field: a focus now came from a press, which opens the list (Tab does not). */
  let pointerOver = false;
  /** The next focus is ours (after a pick): it does not open the list. */
  let ownFocus = false;

  const core = createCore(
    {
      items,
      query: () => filterQuery(typed(), core.composing() ? core.frozen() : (typed() ?? "")),
      filter: () => props.filter as ComboFilter<Choice> | undefined,
      limit: () => props.limit ?? -1,
      hideExact: () => false,
      auto: () => (props.autoHighlight === undefined ? "always" : props.autoHighlight === true ? "input-change" : props.autoHighlight || false),
      chosen: () => chosenIndices(),
      loop: () => props.loopFocus ?? true,
      inline: () => props.inline === true,
      disabled: () => props.disabled === true,
      rows: COMBOBOX_ROWS,
      open: () => props.open,
      defaultOpen: props.defaultOpen,
      onOpenChange: (open, change) => props.onOpenChange?.(open, change),
      closed: () => {
        const was = typed();
        typed.set(reconcileTyped({ event: "close", typed: was, multiple: multiple(), open: false }));
        chipCursor.set(-1);
        if (was !== undefined) props.onInputChange?.(title(), "reset");
      },
      onHighlight: (c, reason, pos) => props.onItemHighlighted?.(c as ComboOption<T> | undefined, { reason, index: pos }),
      loading: () => props.loading === true,
      empty: () => props.empty ?? "No results",
    },
    (c) => chosenSet().has(c.value),
  );
  const { state, nav, model } = core;
  const editable = () => props.readOnly !== true && props.disabled !== true;
  const name = () => props.label ?? props.name ?? props.placeholder ?? "Select";
  const shown = () => typed() ?? title();

  // The value changed under the field (a pick, or its owner): the field follows unless the user is typing.
  effect(() => {
    values();
    untracked(() => {
      const was = typed();
      const next = reconcileTyped({ event: "value", typed: was, multiple: multiple(), open: state.open() });
      if (next !== was) typed.set(next);
    });
  });

  const focusField = () => {
    if (core.focused()) return;
    ownFocus = true;
    field?.focus();
  };
  const clearChipsFor = (next: string[]) => {
    chipCursor.set(-1);
    (props.onChange as (v: string[]) => void)(next);
  };

  const pick = (pos: number) => {
    const c = model.choiceAt(pos);
    if (!c || c.disabled || !editable()) return;
    if (multiple()) {
      (props.onChange as (v: T[]) => void)(toggleValue(values() as T[], c.value as T));
      typed.set(reconcileTyped({ event: "pick", typed: typed(), multiple: true, open: true }));
      // A typed filter ends with the list; an owner that cancels this close keeps the list, the filter and the highlight.
      core.hide("item-press");
    } else {
      (props.onChange as (v: T) => void)(c.value as T);
      typed.set(reconcileTyped({ event: "pick", typed: typed(), multiple: false, open: true }));
      props.onInputChange?.(textOf(c), "reset");
      core.hide("item-press");
    }
    focusField();
  };

  const clear = () => {
    if (!editable()) return;
    typed.set(undefined);
    if (props.multiple === true) clearChipsFor([]);
    else props.onClear?.();
    focusField();
  };

  const removeChip = (index: number) => {
    if (!editable() || !multiple()) return;
    const count = values().length;
    clearChipsFor(removeAt(values() as T[], index));
    chipCursor.set(chipCursorAfter(index, count));
    focusField();
  };
  const chipCursorAfter = (index: number, count: number) => (chipCursor() < 0 ? -1 : chipAfterRemoval(index, count));

  const change = ({ value: v }: { value: string }) => {
    if (!editable()) return;
    typed.set(v);
    chipCursor.set(-1);
    const verdict = typingOpens({ text: v, composing: core.composing(), openOnInputClick: props.openOnInputClick ?? true, readOnly: false });
    if (verdict === "open") core.show("none");
    else if (verdict === "close") core.hide("none");
    if (!core.composing()) {
      props.onInputChange?.(v, "type");
      // Emptying the field is how a single choice is cleared, when the owner lets it be cleared.
      if (v === "" && props.multiple !== true && props.onClear && values().length > 0) props.onClear();
    }
    if (props.autoHighlight === false) nav.clear();
  };

  // Left from the start of the field walks the chips; once on one, Left and Right move and Delete removes it.
  effect(() => {
    const count = values().length;
    if (!multiple() || !core.focused() || core.composing() || count === 0) return;
    const cursor = chipCursor();
    if (cursor < 0 && !(caretAtStart() && shown() === "")) return;
    const walk = (dir: 1 | -1) => () => chipCursor.set(chipStep(untracked(chipCursor), dir, count));
    return keymap.bind(cursor < 0 ? { left: walk(-1) } : { left: walk(-1), right: walk(1), delete: () => removeChip(cursor), backspace: () => removeChip(cursor) }, { when: "always", repeat: true });
  });

  const invalid = () => props.invalid === true || !!props.error;
  /** The state a screen reader cannot read from the name: nsh has no `required`, `readonly` or `invalid` accessibility state. */
  const stateHint = () => [props.required && "required", props.readOnly && "read only", invalid() && "invalid"].filter(Boolean).join(", ") || undefined;
  const hasValue = () => values().length > 0;
  const clearable = () => editable() && hasValue() && (props.multiple === true ? props.clear === true : !!props.onClear);
  const small = () => (props.small ? "h-7 text-xs" : "");

  const input = (
    <View
      onTouchStartCapture={() => {
        if (props.openOnInputClick !== false && !core.state.open()) core.show("trigger-press");
      }}
      class={multiple() ? "min-w-16 flex-1" : undefined}
    >
      <Input
        ref={(node: InputRef) => {
          field = node;
        }}
        autoFocus={props.autoFocus}
        value={shown()}
        placeholder={multiple() && hasValue() ? "" : (props.placeholder ?? "Select…")}
        role="combobox"
        accessibilityLabel={name()}
        accessibilityHint={stateHint()}
        accessibilityState={{ expanded: core.visible(), disabled: props.disabled }}
        autoCorrect={false}
        submitBehavior="submit"
        readonly={props.readOnly}
        disabled={props.disabled}
        onChange={change}
        onCompositionChange={(e) => {
          if (e.composing && !core.composing()) core.frozen.set(filterQuery(typed(), typed() ?? ""));
          const ended = !e.composing && core.composing();
          core.composing.set(e.composing);
          // The owner hears the text only when it is settled: what a composition ended with is typed text too.
          if (ended && typed() !== undefined) props.onInputChange?.(typed() ?? "", "type");
        }}
        onSelectionChange={(e) => caretAtStart.set(e.start === 0 && e.end === 0)}
        onKeyPress={(e) => {
          if (e.key !== "Backspace" || !multiple() || !editable() || core.composing() || shown() !== "" || !hasValue()) return;
          removeChip(values().length - 1);
        }}
        onFocus={() => {
          core.focused.set(true);
          core.cancelBlur();
          // The title is selected, so typing replaces it instead of editing it.
          if (!multiple()) field?.setSelection(0, 1000);
          const own = ownFocus;
          ownFocus = false;
          if (!own && pointerOver && (props.openOnInputClick ?? true) && !state.open()) core.show("trigger-focus");
        }}
        onBlur={() => {
          core.focused.set(false);
          core.composing.set(false);
          ownFocus = false;
          chipCursor.set(-1);
          if (props.inline) return;
          core.blurSoon();
        }}
        onSubmit={() => {
          if (core.composing()) return;
          if (core.visible() && nav.active() >= 0) pick(nav.active());
          else if (!props.inline) core.hide("none");
        }}
        style={multiple() ? undefined : hoverTransition()}
        class={
          multiple()
            ? "h-6 border-0 bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground"
            : `${INPUT_CLASS} ${clearable() ? "pr-14" : "pr-8"} ${small()} ${invalid() ? INVALID : ""}`
        }
      />
    </View>
  );

  const chevron = (
    <View
      role="button"
      focusable={false}
      accessibilityLabel={`${core.visible() ? "Close" : "Open"} ${name()} list`}
      accessibilityState={{ expanded: core.visible(), disabled: props.disabled }}
      disabled={props.disabled}
      onPressDown={core.hold.down}
      onPressUp={core.hold.up}
      onPress={() => {
        focusField();
        if (core.state.open()) core.hide("trigger-press");
        else core.show("trigger-press");
      }}
      class={`absolute inset-y-0 right-0 w-8 items-center justify-center ${props.inline ? "hidden" : ""}`}
    >
      <Icon name="chevron-down" size={14} tone="muted-foreground" />
    </View>
  );

  const clearButton = (
    <If when={clearable()}>
      <View
        role="button"
        focusable={false}
        accessibilityLabel={`Clear selection: ${name()}`}
        onPressDown={core.hold.down}
        onPressUp={core.hold.up}
        onPress={clear}
        class={`absolute inset-y-0 ${props.inline ? "right-0" : "right-7"} w-7 items-center justify-center`}
      >
        <Icon name="x" size={14} tone="muted-foreground" />
      </View>
    </If>
  );

  const chips = computed(() => {
    const max = (props.multiple === true && props.maxChips) || CHIPS_SHOWN;
    const out: { value: string; text: string }[] = [];
    if (!multiple()) return out;
    const byValue = new Map<string, Choice>();
    const want = new Set(values().slice(0, max));
    for (const c of items()) if (want.has(c.value)) byValue.set(c.value, c);
    for (const v of values().slice(0, max)) out.push({ value: v, text: byValue.has(v) ? textOf(byValue.get(v)!) : v });
    return out;
  });

  const field_ = multiple() ? (
    <View
      ref={(node: ViewRef) => core.setAnchor(node)}
      onLayout={core.laid}
      onMouseEnter={() => {
        pointerOver = true;
      }}
      onMouseLeave={() => {
        pointerOver = false;
      }}
      class={`relative min-h-8 flex-row flex-wrap items-center gap-1 rounded-md border bg-card py-1 pl-1.5 pr-8 ${core.focused() ? "border-ring" : invalid() ? "border-destructive" : "border-input hover:border-muted-foreground/50"}`}
    >
      <Each of={chips()} key={(c: { value: string; text: string }) => c.value}>
        {(chip, index) => (
          <View class={`h-6 flex-row items-center gap-0.5 rounded bg-muted pl-2 pr-0.5 ${chipCursor() === index() ? "outline-2 outline-ring" : ""}`}>
            <Text class="max-w-48 line-clamp-1 text-xs text-foreground">
              {chip().text}
            </Text>
            <View
              role="button"
              focusable={false}
              accessibilityLabel={`Remove ${chip().text}`}
              onPressDown={core.hold.down}
              onPressUp={core.hold.up}
              onPress={() => removeChip(index())}
              class="size-5 items-center justify-center rounded hover:bg-accent"
            >
              <Icon name="x" size={12} tone="muted-foreground" />
            </View>
          </View>
        )}
      </Each>
      <If when={values().length > chips().length}>
        <Text class="px-1 text-xs text-muted-foreground">{`+${values().length - chips().length}`}</Text>
      </If>
      {input}
      {clearButton}
      {chevron}
    </View>
  ) : (
    <View
      ref={(node: ViewRef) => core.setAnchor(node)}
      class="relative"
      onLayout={core.laid}
      onMouseEnter={() => {
        pointerOver = true;
      }}
      onMouseLeave={() => {
        pointerOver = false;
      }}
    >
      {input}
      {clearButton}
      {chevron}
    </View>
  );

  const box = (
    <View>
      {field_}
      <If when={core.visible()}>
        <ListPopup
          core={core}
          width={Math.max(core.width(), hasHint() ? HINT_WIDTH : 240)}
          inline={props.inline === true}
          picked={(c) => chosenSet().has(c.value)}
          onPick={pick}
          empty={props.empty ?? "No results"}
          loading={props.loading === true}
          onClose={core.hide}
        />
      </If>
    </View>
  );

  return props.label ? (
    <Labeled label={props.label} error={props.error} hint={props.hint} reserve={props.reserve}>
      {box}
    </Labeled>
  ) : (
    box
  );
}

export interface Suggestion {
  text: string;
  /** Secondary text after the suggestion, also searched. */
  hint?: string;
  group?: string;
  disabled?: boolean;
  keywords?: string;
}

/**
 * A text field that suggests while you type. The value is whatever is typed (a suggestion only saves typing), so
 * it is for names and places, not for a fixed set (that is a `Combobox`). Nothing is highlighted until Down is
 * pressed (`autoHighlight` changes that), so Enter still submits the form with what was typed; with a suggestion
 * highlighted it picks that one. The list opens when typing, or on Down in a focused field, and closes on Escape, a
 * pick, or leaving the field. `onPick` runs after `onChange` for a picked suggestion (an agent's machine follows
 * the agent). `mode` is what the text does while a row is highlighted (Base UI's `mode`): `list` filters and leaves
 * the text, `both` filters and shows the highlighted row's text, `inline` shows every suggestion and the row's text,
 * `none` shows every suggestion and leaves the text.
 */
export function Autocomplete(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: (string | Suggestion)[];
  onPick?: (s: Suggestion) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  reserve?: boolean;
  autoFocus?: boolean;
  mono?: boolean;
  onSubmit?: () => void;
  onBlur?: () => void;
  mode?: AutocompleteMode;
  autoHighlight?: boolean | "always";
  /** A press on the input opens the list (default false: typing or Down does). */
  openOnInputClick?: boolean;
  inline?: boolean;
  limit?: number;
  filter?: ComboFilter<Suggestion>;
  loading?: boolean;
  /** What the list says when nothing matches (default: no list at all). */
  empty?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** Shows a clear button while there is text. */
  clear?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
  onItemHighlighted?: (suggestion: Suggestion | undefined, details: HighlightDetails) => void;
  loopFocus?: boolean;
  keepHighlight?: boolean;
}) {
  const mode = () => props.mode ?? "list";
  const suggestions = computed(() => props.suggestions);
  const items = computed<readonly Choice[]>(() => suggestions().map((s) => (typeof s === "string" ? { value: s, title: s } : { value: s.text, title: s.text, hint: s.hint, group: s.group, disabled: s.disabled, keywords: s.keywords })));
  const hasHint = computed(() => items().some((c) => c.hint));
  /** The row text shown in the field while a row is highlighted (`both`, `inline`); `undefined`: what was typed. */
  const completion = signal<string | undefined>(undefined);
  let field: InputRef | undefined;
  let pointerOver = false;
  const suggestionOf = (c: Choice): Suggestion => ({ text: c.value, hint: c.hint, group: c.group, disabled: c.disabled, keywords: c.keywords });

  const core = createCore(
    {
      items,
      query: () => (filtersByText(mode()) ? (core.composing() ? core.frozen() : props.value) : ""),
      filter: () => (filtersByText(mode()) ? (props.filter as ComboFilter<Choice> | undefined) : null),
      limit: () => props.limit ?? -1,
      hideExact: () => filtersByText(mode()),
      auto: () => (props.autoHighlight === undefined ? false : props.autoHighlight === true ? "input-change" : props.autoHighlight || false),
      chosen: () => [],
      loop: () => props.loopFocus ?? true,
      inline: () => props.inline === true,
      disabled: () => props.disabled === true,
      rows: AUTOCOMPLETE_ROWS,
      open: () => props.open,
      defaultOpen: props.defaultOpen,
      onOpenChange: (open, change) => props.onOpenChange?.(open, change),
      closed: () => completion.set(undefined),
      onHighlight: (c, reason, pos) => {
        props.onItemHighlighted?.(c && suggestionOf(c), { reason, index: pos });
        completion.set(inlineText(mode(), c?.title, reason, props.readOnly === true));
      },
      loading: () => props.loading === true,
      empty: () => props.empty,
    },
    () => false,
  );
  const { state, nav, model } = core;
  const shown = () => completion() ?? props.value;
  const editable = () => props.readOnly !== true && props.disabled !== true;
  const invalid = () => props.invalid === true || !!props.error;

  // The text changed under the field (its owner): a completion in progress is over.
  effect(() => {
    props.value;
    untracked(() => completion.set(undefined));
  });

  const pick = (pos: number) => {
    const c = model.choiceAt(pos);
    if (!c || c.disabled || !editable()) return;
    completion.set(undefined);
    props.onChange(c.value);
    props.onPick?.(suggestionOf(c));
    core.hide("item-press");
    nav.clear();
    if (!core.focused()) field?.focus();
  };

  const typedOpen = (text: string) => {
    const verdict = typingOpens({ text, composing: core.composing(), openOnInputClick: props.openOnInputClick ?? false, readOnly: !editable() });
    if (verdict === "open") core.show("none");
    else if (verdict === "close") core.hide("none");
  };

  const field_ = (
    <View
      ref={(node: ViewRef) => core.setAnchor(node)}
      class="relative"
      onLayout={core.laid}
      onMouseEnter={() => {
        pointerOver = true;
      }}
      onMouseLeave={() => {
        pointerOver = false;
      }}
    >
      <View
        onTouchStartCapture={() => {
          if (props.openOnInputClick === true && !state.open() && editable()) core.show("trigger-press");
        }}
      >
        <Input
          ref={(node: InputRef) => {
            field = node;
          }}
          autoFocus={props.autoFocus}
          value={shown()}
          placeholder={props.placeholder}
          role="combobox"
          accessibilityState={{ expanded: core.visible(), disabled: props.disabled }}
          accessibilityLabel={props.label || props.placeholder}
          accessibilityHint={[props.required && "required", props.readOnly && "read only", invalid() && "invalid"].filter(Boolean).join(", ") || undefined}
          autoCorrect={false}
          submitBehavior="submit"
          readonly={props.readOnly}
          disabled={props.disabled}
          onChange={({ value: v }) => {
            if (!editable()) return;
            completion.set(undefined);
            props.onChange(v);
            if (props.autoHighlight === undefined || props.autoHighlight === false) nav.clear();
            typedOpen(v);
          }}
          onCompositionChange={(e) => {
            if (e.composing && !core.composing()) core.frozen.set(props.value);
            core.composing.set(e.composing);
          }}
          onFocus={() => {
            core.focused.set(true);
            core.cancelBlur();
            if (pointerOver && props.openOnInputClick === true && !state.open() && editable()) core.show("trigger-focus");
          }}
          onBlur={() => {
            core.focused.set(false);
            core.composing.set(false);
            props.onBlur?.();
            if (props.inline) return;
            // Pressing a suggestion blurs the input first: wait for the press to land before closing.
            core.blurSoon();
          }}
          onSubmit={() => {
            if (core.composing()) return;
            if (core.visible() && nav.active() >= 0) pick(nav.active());
            else {
              if (!props.inline) core.hide("none");
              props.onSubmit?.();
            }
          }}
          style={hoverTransition()}
          class={`${INPUT_CLASS} ${props.clear && props.value ? "pr-8" : ""} ${props.mono ? "font-mono" : ""} ${invalid() ? INVALID : ""}`}
        />
      </View>
      <If when={props.clear && !!props.value && editable()}>
        <View
          role="button"
          focusable={false}
          accessibilityLabel={`Clear: ${props.label || props.placeholder || ""}`}
          onPressDown={core.hold.down}
          onPressUp={core.hold.up}
          onPress={() => {
            completion.set(undefined);
            props.onChange("");
            field?.focus();
          }}
          class="absolute inset-y-0 right-0 w-8 items-center justify-center"
        >
          <Icon name="x" size={14} tone="muted-foreground" />
        </View>
      </If>
    </View>
  );

  // Down opens the suggestions even where typing has not: a list to browse.
  return (
    <Labeled label={props.label} error={props.error} hint={props.hint} reserve={props.reserve}>
      <View>
        {field_}
        <If when={core.visible()}>
          <ListPopup
            core={core}
            width={Math.max(core.width(), hasHint() ? HINT_WIDTH : 0)}
            inline={props.inline === true}
            picked={() => false}
            onPick={pick}
            empty={props.empty}
            loading={props.loading === true}
            onClose={core.hide}
          />
        </If>
      </View>
    </Labeled>
  );
}
