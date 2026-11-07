import { expect, test } from "nsh/test";
import {
  add,
  canBeNumber,
  clamp,
  commitText,
  createHold,
  formatNumber,
  HOLD_DELAY_MS,
  NUMBER_KEYS,
  parseNumber,
  roundTo,
  stepBy,
} from "./number";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("numbers are written the English way: comma for thousands, dot for decimals, no digit hidden", () => {
  expect(formatNumber(1234567.891)).toBe("1,234,567.891");
  expect(formatNumber(1234)).toBe("1,234");
  expect(formatNumber(0.5)).toBe("0.5");
  expect(formatNumber(null)).toBe("");
  expect(formatNumber(0)).toBe("0");
  // a value is shown with all its digits, not rounded to Intl's three
  expect(formatNumber(12.3456)).toBe("12.3456");
  expect(formatNumber(0.000001)).toBe("0.000001");
  expect(formatNumber(-0)).toBe("0");
});

test("format options: fraction digits, percent, currency and unit labels", () => {
  expect(formatNumber(12.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe("12.50");
  expect(formatNumber(0.256, { style: "percent", maximumFractionDigits: 1 })).toBe("25.6%");
  expect(formatNumber(1500000, { style: "currency", currency: "USD" })).toBe("$1,500,000.00");
  expect(formatNumber(1234.5, { style: "unit", unit: "kilogram" })).toBe("1,234.5 kg");
});

test("what people paste is read in both conventions", () => {
  expect(parseNumber("1.234,5")).toBe(1234.5);
  expect(parseNumber("1,234.5")).toBe(1234.5);
  expect(parseNumber("1.234.567,89")).toBe(1234567.89);
  expect(parseNumber("1,234,567.89")).toBe(1234567.89);
  expect(parseNumber("1.234.567")).toBe(1234567);
  expect(parseNumber("1,234,567")).toBe(1234567);
  expect(parseNumber("1 234 567,5")).toBe(1234567.5);
  expect(parseNumber("1\u00a0234,5")).toBe(1234.5);
  expect(parseNumber("12,5")).toBe(12.5);
  expect(parseNumber("12.5")).toBe(12.5);
  expect(parseNumber(",5")).toBe(0.5);
  expect(parseNumber("5,")).toBe(5);
  expect(parseNumber("007")).toBe(7);
});

test("a lone comma before exactly three digits is thousands; anything else is a decimal", () => {
  expect(parseNumber("1,234")).toBe(1234);
  expect(parseNumber("12,345")).toBe(12345);
  expect(parseNumber("0,234")).toBe(0.234);
  expect(parseNumber("1,5")).toBe(1.5);
  expect(parseNumber("12,3456")).toBe(12.3456);
  expect(parseNumber("1234,567")).toBe(1234.567);
  // a lone dot is always the decimal point
  expect(parseNumber("1.234")).toBe(1.234);
});

test("separators that cannot be read as one number are refused", () => {
  expect(parseNumber("1.2.3")).toBeNull();
  expect(parseNumber("1,2,3")).toBeNull();
  expect(parseNumber("1,2.3")).toBeNull();
  expect(parseNumber("12,5,5")).toBeNull();
  expect(parseNumber("")).toBeNull();
  expect(parseNumber("-")).toBeNull();
  expect(parseNumber(",")).toBeNull();
  expect(parseNumber("abc")).toBeNull();
  expect(parseNumber("12kg")).toBeNull();
  expect(parseNumber("1e5")).toBeNull();
});

test("signs lead or trail, and a unicode minus counts", () => {
  expect(parseNumber("-12,5")).toBe(-12.5);
  expect(parseNumber("\u221212,5")).toBe(-12.5);
  expect(parseNumber("12,5-")).toBe(-12.5);
  expect(parseNumber("+12,5")).toBe(12.5);
  expect(parseNumber("(12.5)", { style: "currency", currency: "USD", currencySign: "accounting" })).toBe(-12.5);
});

test("labels and percent do not disturb reading, and percent is exact", () => {
  expect(parseNumber("$1,500,000", { style: "currency", currency: "USD" })).toBe(1500000);
  expect(parseNumber("1,500,000 USD", { style: "currency", currency: "USD" })).toBe(1500000);
  expect(parseNumber("1,234.5 kg", { style: "unit", unit: "kilogram" })).toBe(1234.5);
  expect(parseNumber("25.6%", { style: "percent" })).toBe(0.256);
  expect(parseNumber("7%", { style: "percent" })).toBe(0.07);
  expect(parseNumber("7", { style: "percent" })).toBe(0.07);
});

test("a number survives being shown and read back", () => {
  for (const n of [0, 1, -1, 12.5, 1234.5678, 0.1 + 0.2, 1e-7 * 3, 123456789.123456, -0.001, 1e15]) {
    const clean = Number(n.toPrecision(15));
    expect(parseNumber(formatNumber(clean))).toBe(clean);
  }
  const money = { style: "currency", currency: "USD" } as const;
  expect(parseNumber(formatNumber(2500000, money), money)).toBe(2500000);
  const pct = { style: "percent", maximumFractionDigits: 2 } as const;
  expect(parseNumber(formatNumber(0.0725, pct), pct)).toBe(0.0725);
});

test("typing may only produce characters a number has", () => {
  expect(canBeNumber("1.234,5")).toBe(true);
  expect(canBeNumber("-12")).toBe(true);
  expect(canBeNumber("")).toBe(true);
  expect(canBeNumber("12a")).toBe(false);
  expect(canBeNumber("1 234")).toBe(true);
  // no minus where nothing below zero is allowed
  expect(canBeNumber("-1", undefined, false)).toBe(false);
  expect(canBeNumber("12%", { style: "percent" })).toBe(true);
  expect(canBeNumber("12%")).toBe(false);
  // the unit of the format may be typed and deleted letter by letter
  expect(canBeNumber("12 k", { style: "unit", unit: "kilogram" })).toBe(true);
});

test("sums do not pick up binary noise", () => {
  expect(0.1 + 0.2).not.toBe(0.3);
  expect(add(0.1, 0.2)).toBe(0.3);
  expect(add(0.7, 0.1)).toBe(0.8);
  expect(add(1.1, -0.1)).toBe(1);
  expect(add(1000000.1, 0.2)).toBe(1000000.3);
  expect(add(1e-7, 2e-7)).toBe(3e-7);
  expect(add(2, 3)).toBe(5);
  expect(roundTo(1.005, 2)).toBe(1.01);
  expect(roundTo(-1.005, 2)).toBe(-1.01);
  expect(roundTo(2.5, 0)).toBe(3);
  expect(roundTo(12.5, 3)).toBe(12.5);
});

test("a step moves by its amount, from nothing it starts at 0, and it stops at the bounds", () => {
  const free = { snap: false, nearest: false };
  expect(stepBy(5, 1, 1, free)).toBe(6);
  expect(stepBy(5, -1, 1, free)).toBe(4);
  expect(stepBy(0.1, 1, 0.2, free)).toBe(0.3);
  expect(stepBy(null, 1, 1, free)).toBe(0);
  expect(stepBy(null, -1, 1, free)).toBe(0);
  // the seed goes to the allowed value nearest 0
  expect(stepBy(null, 1, 1, { ...free, min: 5 })).toBe(5);
  expect(stepBy(null, -1, 1, { ...free, max: -2 })).toBe(-2);
  expect(stepBy(9.5, 1, 1, { ...free, max: 10 })).toBe(10);
  expect(stepBy(0.5, -1, 1, { ...free, min: 0 })).toBe(0);
});

test("snapping puts a step on the grid from min, in the direction of travel", () => {
  const snap = { snap: true, nearest: false };
  expect(stepBy(5.3, 1, 1, snap)).toBe(6);
  expect(stepBy(5.3, -1, 1, snap)).toBe(5);
  expect(stepBy(5, 1, 1, snap)).toBe(6);
  expect(stepBy(5, 1, 5, { ...snap, min: 2 })).toBe(7);
  expect(stepBy(12, 1, 5, { ...snap, min: 2 })).toBe(17);
  expect(stepBy(10, 1, 5, { ...snap, min: 2 })).toBe(12);
  expect(stepBy(0.2, 1, 0.1, snap)).toBe(0.3);
  expect(stepBy(0.25, 1, 0.1, snap)).toBe(0.3);
  expect(stepBy(0.25, -1, 0.1, snap)).toBe(0.2);
  // a small step goes to the nearest grid line
  expect(stepBy(5.34, 1, 0.1, { snap: true, nearest: true })).toBe(5.4);
  expect(clamp(5, 0, 3)).toBe(3);
  expect(clamp(-5, 0, 3)).toBe(0);
  expect(clamp(5)).toBe(5);
});

test("the keys: arrows step, Shift and the Page keys step large, mod steps small, Home and End are the bounds", () => {
  expect(NUMBER_KEYS.up).toEqual({ dir: 1, size: "step" });
  expect(NUMBER_KEYS["shift+down"]).toEqual({ dir: -1, size: "large" });
  expect(NUMBER_KEYS.pageup).toEqual({ dir: 1, size: "large" });
  expect(NUMBER_KEYS["mod+up"]).toEqual({ dir: 1, size: "small" });
  expect(NUMBER_KEYS.home).toEqual({ bound: "min" });
  // never alt: Option types characters and AltGr is Ctrl+Alt
  expect(Object.keys(NUMBER_KEYS).some((k) => k.includes("alt"))).toBe(false);
});

test("a typed text commits to empty, a clamped number, or stays unreadable", () => {
  const bounds = { min: 0, max: 100, allowOutOfRange: false };
  expect(commitText("", bounds)).toEqual({ kind: "empty" });
  expect(commitText("   ", bounds)).toEqual({ kind: "empty" });
  expect(commitText("42,5", bounds)).toEqual({ kind: "value", value: 42.5 });
  expect(commitText("250", bounds)).toEqual({ kind: "value", value: 100 });
  expect(commitText("-5", bounds)).toEqual({ kind: "value", value: 0 });
  expect(commitText("abc", bounds)).toEqual({ kind: "bad" });
  expect(commitText("250", { ...bounds, allowOutOfRange: true })).toEqual({ kind: "value", value: 250 });
  // fraction digits of the format round the stored value
  expect(commitText("1,23456", { allowOutOfRange: false, format: { maximumFractionDigits: 2 } })).toEqual({ kind: "value", value: 1.23 });
});

test("holding a stepper steps once, then repeats after the delay, and a step that changes nothing ends it", async () => {
  expect(HOLD_DELAY_MS).toBe(400);
  let steps = 0;
  const hold = createHold(() => ++steps > 0, 40, 10);
  hold.start();
  expect(steps).toBe(1);
  await wait(25);
  expect(steps).toBe(1);
  // Poll: a loaded runner's timers are late, and the repeat is what is asserted, not how late.
  for (let i = 0; i < 100 && steps <= 2; i++) await wait(20);
  expect(steps).toBeGreaterThan(2);
  hold.stop();
  const after = steps;
  await wait(40);
  expect(steps).toBe(after);
  expect(hold.running).toBe(false);

  let value = 8;
  const atMax = createHold(() => value < 10 && ++value > 0, 5, 5);
  atMax.start();
  for (let i = 0; i < 100 && atMax.running; i++) await wait(20);
  expect(value).toBe(10);
  expect(atMax.running).toBe(false);

  // a first step that changes nothing never starts the repeat
  let calls = 0;
  const stuck = createHold(() => {
    calls++;
    return false;
  }, 5, 5);
  stuck.start();
  await wait(30);
  expect(calls).toBe(1);
});
