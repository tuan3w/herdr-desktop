/**
 * The rules of a number field, apart from any view: reading what people type and paste, showing a number the way an
 * English reader writes it (comma for thousands, dot for decimals), stepping without binary noise, and clamping.
 * `Intl.NumberFormat` exists in this host, so formatting is its job; reading is ours because `Intl` has no parser and
 * what lands in a field comes from spreadsheets and other apps in both conventions.
 */

/** `Intl.NumberFormat` options: `style: "percent"`, `currency`, `maximumFractionDigits`, `signDisplay`, ... */
export type NumberFormat = Intl.NumberFormatOptions;

const LOCALE = "en-US";
/** Digits shown for a value when `format` names none: enough to show every digit the value has, never hide one. */
const MIN_FRACTION = 3;
const MAX_FRACTION = 20;

const formatters = new Map<string, Intl.NumberFormat>();
const formatterOf = (format: NumberFormat) => {
  const key = JSON.stringify(format);
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.NumberFormat(LOCALE, format)));
  return f;
};

/**
 * How many digits follow the decimal point of `n` as JS prints it (`0.1` is 1, `1e-7` is 7). Binary noise is not a digit
 * here: `0.1 + 0.2` prints 17 of them, and `add` is how a sum avoids that.
 */
export function decimals(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const text = String(n);
  const e = text.indexOf("e");
  const mantissa = e === -1 ? text : text.slice(0, e);
  const dot = mantissa.indexOf(".");
  const own = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, own - (e === -1 ? 0 : Number(text.slice(e + 1))));
}

/** A value as the field writes it: English separators, `null` is the empty text. No digit of the value is hidden unless `format` rounds. */
export function formatNumber(value: number | null, format?: NumberFormat): string {
  if (value === null || !Number.isFinite(value)) return "";
  // "-0" is what Intl prints for a negative zero, and a value that rounds to zero must not show a sign.
  const shown = Object.is(value, -0) ? 0 : value;
  const plain =
    !format ||
    ((format.style ?? "decimal") === "decimal" &&
      format.maximumFractionDigits === undefined &&
      format.minimumFractionDigits === undefined);
  if (!plain) return formatterOf(format ?? {}).format(shown);
  const digits = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, decimals(shown)));
  return formatterOf({ ...format, maximumFractionDigits: digits }).format(shown);
}

const SPACES = /[\s\u00a0\u2007\u2009\u202f]/g;
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MINUS = /[-\u2212\u2012\u2013\u2014\ufe63\uff0d]/;
const PLUS = /[+\ufe62\uff0b]/;

const labelCache = new Map<string, string[]>();

/** The labels `format` puts around the digits (`$`, `US$`, `kg`): reading ignores them. */
function labelsOf(format: NumberFormat | undefined): string[] {
  if (!format || (format.style !== "currency" && format.style !== "unit")) return [];
  const key = JSON.stringify(format);
  let labels = labelCache.get(key);
  if (!labels) {
    labels = formatterOf(format)
      .formatToParts(1234.5)
      .filter((p) => p.type === "currency" || p.type === "unit")
      .map((p) => p.value);
    // A currency is also written with its code.
    if (format.style === "currency") labels.push(format.currency ?? "");
    labels = labels.filter(Boolean).sort((a, b) => b.length - a.length);
    labelCache.set(key, labels);
  }
  return labels;
}

/** Whether `text` could be on its way to a number: the characters a number carries, and what `format` writes around it. */
export function canBeNumber(text: string, format?: NumberFormat, negative = true): boolean {
  let rest = text.replace(BIDI, "");
  for (const label of labelsOf(format)) rest = rest.split(label).join("");
  // A label being typed or deleted letter by letter is still on its way to one.
  if (format && (format.style === "currency" || format.style === "unit"))
    rest = rest.replace(/[^\d.,\s'\u2019%+\-\u2212\u2012\u2013\u2014\ufe63\uff0d()]/gu, "");
  const percent = format?.style === "percent" ? "%" : "";
  const sign = negative ? "\\-\\u2212\\u2012\\u2013\\u2014\\ufe63\\uff0d" : "";
  return new RegExp(
    `^[\\d.,\\s\\u00a0\\u2007\\u2009\\u202f'\\u2019+${sign}${percent}${negative && format?.currencySign === "accounting" ? "()" : ""}]*$`,
    "u",
  ).test(rest);
}

/**
 * Reads a number from what a person typed or pasted, in either convention.
 *
 * - Both `.` and `,` present: the **last** one is the decimal separator and the other groups thousands
 *   (`1.234,5` and `1,234.5` are 1234.5; `1.234.567,89` is 1234567.89).
 * - One of them more than once: grouping, and it must group by three (`1.234.567`; `1.2.3` is not a number).
 * - A `.` once: the decimal point (English): `1.234` is 1.234, `12.5` is 12.5.
 * - A `,` once: the decimal separator, unless it can only be grouping: a lone `,` followed by exactly three digits after
 *   1 to 3 digits that do not start with 0 is thousands (`1,234` is 1234, `0,234` and `1,5` and `12,3456` are decimals).
 *   Typing `12,345` meaning twelve and a bit therefore reads as 12345: the cost of reading the English convention first.
 * - Spaces (also no-break and narrow ones) and `'` group; a sign leads or trails (`-12`, `12-`, `(12)` with
 *   `currencySign: "accounting"`); `+` is ignored; the labels of `format` (`$`, `kg`) and `%` are ignored, and with
 *   `style: "percent"` the result is divided by 100 as a decimal, not a float.
 * Returns `null` for anything else (empty, a sign alone, letters). The digits go to `Number` as one decimal string, so
 * no digit is lost to arithmetic.
 */
export function parseNumber(text: string, format?: NumberFormat): number | null {
  let s = text.replace(BIDI, "");
  for (const label of labelsOf(format)) s = s.split(label).join("");
  s = s.replace(SPACES, "");
  let negative = false;
  const accounting = format?.currencySign === "accounting" && /^\(.*\)$/.test(s);
  if (accounting) {
    negative = true;
    s = s.slice(1, -1);
  }
  const lead = s.charAt(0);
  if (MINUS.test(lead)) {
    negative = true;
    s = s.slice(1);
  } else if (PLUS.test(lead)) s = s.slice(1);
  const trail = s.charAt(s.length - 1);
  if (MINUS.test(trail)) {
    negative = true;
    s = s.slice(0, -1);
  } else if (PLUS.test(trail)) s = s.slice(0, -1);
  const percent = /%/.test(s);
  s = s.replace(/%/g, "").replace(/['\u2019]/g, "");
  if (!/^[\d.,]*$/.test(s) || !/\d/.test(s)) return null;

  const dots = s.split(".").length - 1;
  const commas = s.split(",").length - 1;
  let integer: string;
  let fraction = "";
  const grouped = (digits: string, sep: string) => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})*$`).test(digits);
  if (dots > 0 && commas > 0) {
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const group = decimal === "." ? "," : ".";
    const at = s.lastIndexOf(decimal);
    const head = s.slice(0, at);
    fraction = s.slice(at + 1);
    if (head.includes(decimal) || fraction.includes(group)) return null;
    if (head !== "" && !grouped(head, group)) return null;
    integer = head.split(group).join("");
  } else if (dots > 1 || commas > 1) {
    const sep = dots > 1 ? "." : ",";
    if (!grouped(s, sep)) return null;
    integer = s.split(sep).join("");
  } else if (dots === 1) {
    [integer, fraction] = s.split(".") as [string, string];
  } else if (commas === 1) {
    const [head, tail] = s.split(",") as [string, string];
    if (/^[1-9]\d{0,2}$/.test(head) && /^\d{3}$/.test(tail)) integer = head + tail;
    else {
      integer = head;
      fraction = tail;
    }
  } else integer = s;

  const scale = percent || format?.style === "percent" ? "e-2" : "";
  const value = Number(`${negative ? "-" : ""}${integer || "0"}${fraction ? `.${fraction}` : ""}${scale}`);
  return Number.isFinite(value) ? value : null;
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** Rounds to a float that is the shortest of its neighbours: a sum like 0.1 + 0.2 that came out as 0.30000000000000004. */
function clean(value: number): number {
  const rounded = Number(value.toPrecision(15));
  return Math.abs(rounded - value) <= Math.min(Number.EPSILON * Math.max(1, Math.abs(value)), 1e-10) ? rounded : value;
}

/** `a + b` as a decimal sum: `add(0.1, 0.2)` is `0.3`. Falls back to a cleaned float when the digits do not fit exactly. */
export function add(a: number, b: number): number {
  const d = Math.max(decimals(a), decimals(b));
  if (d === 0) return a + b;
  const f = 10 ** d;
  const x = Math.round(a * f);
  const y = Math.round(b * f);
  return Math.abs(x) > SAFE || Math.abs(y) > SAFE || Math.abs(x + y) > SAFE ? clean(a + b) : (x + y) / f;
}

/** `value` rounded half away from zero to `digits` places, as a decimal (`1.005` to 2 places is `1.01`). */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value) || decimals(value) <= digits) return value;
  const shifted = Number(`${Math.abs(value)}e${digits}`);
  const rounded = Number(`${Math.round(shifted)}e-${digits}`);
  return value < 0 ? -rounded : rounded;
}

export function clamp(value: number, min?: number, max?: number): number {
  let v = value;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

/**
 * The multiple of `step` from `base` that `value` is at (`nearest`) or, otherwise, the one on the side `step`'s sign
 * points to: stepping up from 5.3 by 1 lands on 6, down on 5. Integer arithmetic on the shared decimals, so 0.3 on a 0.1
 * grid is on it.
 */
function snapTo(value: number, base: number, step: number, nearest: boolean): number {
  const d = Math.max(decimals(value), decimals(base), decimals(step));
  const f = 10 ** d;
  const v = Math.round(value * f);
  const b = Math.round(base * f);
  const s = Math.abs(Math.round(step * f));
  if (s === 0 || Math.abs(v) > SAFE || Math.abs(b) > SAFE) return value;
  const raw = v - b;
  const n = nearest ? Math.round(raw / s) : step > 0 ? Math.floor(raw / s) : Math.ceil(raw / s);
  return (b + n * s) / f;
}

export interface StepRange {
  min?: number;
  max?: number;
  /** Snap the result to the grid of `amount` from `min` (from 0 without one). */
  snap: boolean;
  /** Snap to the nearest grid line, not the one in the direction of travel (a small step). */
  nearest: boolean;
}

/**
 * The value one step from `value`, `dir` 1 up or -1 down. An empty field starts at 0 (or the nearest allowed value to 0)
 * whichever way it goes: that seed is not a step. The result is clamped.
 */
export function stepBy(value: number | null, dir: 1 | -1, amount: number, range: StepRange): number {
  if (value === null) return clamp(0, range.min, range.max);
  let next = add(value, dir * amount);
  if (range.snap) next = snapTo(next, range.min ?? 0, dir * amount, range.nearest);
  return clamp(next, range.min, range.max);
}

/** How far a key or a press moves: the plain `step`, the `smallStep` (mod held) or the `largeStep` (shift held, Page keys). */
export type StepSize = "step" | "small" | "large";

export type NumberKey = { dir: 1 | -1; size: StepSize } | { bound: "min" | "max" };

/**
 * The keys a focused number field takes, as `keymap` names them. Never `alt` (Option types characters on a Mac, AltGr is
 * Ctrl+Alt): `mod` is the small step. Home and End take the bounds, so a field wires them only when it has both (a
 * weight with only a `min` keeps Home for the caret).
 */
export const NUMBER_KEYS: Record<string, NumberKey> = {
  up: { dir: 1, size: "step" },
  down: { dir: -1, size: "step" },
  "shift+up": { dir: 1, size: "large" },
  "shift+down": { dir: -1, size: "large" },
  "mod+up": { dir: 1, size: "small" },
  "mod+down": { dir: -1, size: "small" },
  pageup: { dir: 1, size: "large" },
  pagedown: { dir: -1, size: "large" },
  home: { bound: "min" },
  end: { bound: "max" },
};

/** What a press on a stepper does while held: one step at once, then after `HOLD_DELAY_MS` one every `HOLD_TICK_MS`. Base UI's timing. */
export const HOLD_DELAY_MS = 400;
export const HOLD_TICK_MS = 60;

export interface Hold {
  /** Steps once, and, if that changed something, goes on stepping while held. */
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * Press-and-hold auto-repeat. `step` returns whether it changed anything: a step that did not (a bound was reached) ends
 * the hold, so a value stuck at `max` does not keep ticking.
 */
export function createHold(step: () => boolean, delay = HOLD_DELAY_MS, tick = HOLD_TICK_MS): Hold {
  let first: number | undefined;
  let every: number | undefined;
  const stop = () => {
    clearTimeout(first);
    clearInterval(every);
    first = undefined;
    every = undefined;
  };
  return {
    start() {
      stop();
      if (!step()) return;
      first = setTimeout(() => {
        first = undefined;
        every = setInterval(() => {
          if (!step()) stop();
        }, tick);
      }, delay);
    },
    stop,
    get running() {
      return first !== undefined || every !== undefined;
    },
  };
}

export interface Bounds {
  min?: number;
  max?: number;
  /** Typed values may be outside `min`/`max` (and then count as a range error); steps still clamp. */
  allowOutOfRange: boolean;
  format?: NumberFormat;
}

export type Committed = { kind: "empty" } | { kind: "value"; value: number } | { kind: "bad" };

/**
 * What a typed text means once the field is left or Return is pressed: empty, a number (clamped unless
 * `allowOutOfRange`, rounded to `format`'s fraction digits) or unreadable (the text stays, the field reports `badInput`).
 */
export function commitText(text: string, bounds: Bounds): Committed {
  if (text.trim() === "") return { kind: "empty" };
  const parsed = parseNumber(text, bounds.format);
  if (parsed === null) return { kind: "bad" };
  return { kind: "value", value: settle(parsed, bounds) };
}

/** A typed or pasted number as the field stores it. */
export function settle(value: number, bounds: Bounds): number {
  const digits = bounds.format?.maximumFractionDigits;
  const rounded = digits === undefined ? value : roundTo(value, digits);
  return bounds.allowOutOfRange ? rounded : clamp(rounded, bounds.min, bounds.max);
}
