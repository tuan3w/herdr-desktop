import { computed, signal } from "nsh";

/**
 * Select-all over a partial selection, as Base UI's `CheckboxGroup` with a parent checkbox. The rules are pure so a
 * list of thousands can use them: every step is linear in the number of values, never quadratic.
 */

export type ParentStatus = "mixed" | "on" | "off";

/** What the parent checkbox shows. An empty set is not "all selected". */
export function parentState(selected: number, total: number): { checked: boolean; indeterminate: boolean } {
  return { checked: total > 0 && selected === total, indeterminate: selected > 0 && selected !== total };
}

export interface ParentPress {
  all: readonly string[];
  /** The selection now. */
  value: readonly string[];
  /** The selection the user last made by hand (a child press), which the cycle returns to. */
  remembered: readonly string[];
  status: ParentStatus;
  disabled: (value: string) => boolean;
}

/**
 * A press on the parent. Disabled children cannot be changed, so "all" keeps them as they were and "none" keeps the
 * ones that were selected. From none or all it flips between the two; from a partial selection it goes to all, then
 * none, then back to the partial selection the user made (Base UI's cycle), so a bulk "select all" is not a way to lose
 * a hand-picked set.
 */
export function pressParent(p: ParentPress): { value: string[]; status: ParentStatus } {
  const before = new Set(p.remembered);
  const none = p.all.filter((v) => p.disabled(v) && before.has(v));
  const all = p.all.filter((v) => !p.disabled(v) || before.has(v));
  if (p.remembered.length === all.length || p.remembered.length === 0) {
    return { value: p.value.length === all.length ? none : all, status: p.status };
  }
  if (p.status === "mixed") return { value: all, status: "on" };
  if (p.status === "on") return { value: none, status: "off" };
  return { value: [...p.remembered], status: "mixed" };
}

/** What `onValueChange` is told, and may veto. */
export interface ValueChange {
  cancel(): void;
}

/**
 * A group of checkboxes sharing one array of selected values (`value` controlled, or `defaultValue` and the group
 * holds it). `all` is every value that can be selected: the parent is checked when they all are and indeterminate
 * when some are. A child reads `has(value)`; a press calls `toggle`. `onValueChange` may `cancel()` a change.
 */
export function createCheckGroup(options: {
  all: () => readonly string[];
  value?: () => readonly string[] | undefined;
  defaultValue?: readonly string[];
  onValueChange?: (value: string[], change: ValueChange) => void;
  /** A disabled child keeps its state through the parent's presses. */
  disabled?: (value: string) => boolean;
}) {
  const own = signal<readonly string[]>(options.defaultValue ?? []);
  const value = () => options.value?.() ?? own();
  const set = computed(() => new Set(value()));
  let remembered = value();
  let status: ParentStatus = "mixed";

  const commit = (next: string[]): boolean => {
    let canceled = false;
    options.onValueChange?.(next, {
      cancel: () => {
        canceled = true;
      },
    });
    if (canceled) return false;
    if (options.value?.() === undefined) own.set(next);
    return true;
  };

  return {
    value,
    has: (v: string) => set().has(v),
    toggle(v: string, checked: boolean): boolean {
      const next = checked ? (set().has(v) ? [...value()] : [...value(), v]) : value().filter((x) => x !== v);
      if (!commit(next)) return false;
      remembered = next;
      status = "mixed";
      return true;
    },
    parent: {
      checked: () => parentState(value().length, options.all().length).checked,
      indeterminate: () => parentState(value().length, options.all().length).indeterminate,
      press(): boolean {
        const next = pressParent({ all: options.all(), value: value(), remembered, status, disabled: options.disabled ?? (() => false) });
        if (!commit(next.value)) return false;
        status = next.status;
        return true;
      },
    },
  };
}
