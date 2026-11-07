import { expect, test } from "nsh/test";

import {
  chipAfterRemoval,
  chipStep,
  type Choice,
  createRefiner,
  drawsOwnValue,
  filterQuery,
  found,
  groupChoices,
  inlineText,
  isCutOff,
  initialHighlight,
  layout,
  listRoom,
  nextHighlight,
  pageHighlight,
  queryKey,
  queryWords,
  reconcileTyped,
  removeAt,
  HEAD_H,
  revealOffset,
  ROW_H,
  rowOf,
  startJob,
  stepJob,
  toggleValue,
  typingOpens,
  wordProbe,
} from "./combo-rules";

const OPTIONS: Choice[] = [
  { value: "a", title: "Scaffold bot" },
  { value: "b", title: "Café agent (cf01)" },
  { value: "c", title: "Cargo runner" },
  { value: "d", title: "SES-2610-002", hint: "Zoë local" },
];

/** The values a query shows, in order, through the same steps the component takes. */
function shown(choices: Choice[], query: string, budget = Number.POSITIVE_INFINITY): string[] {
  const words = queryWords(query);
  if (words.length === 0) return choices.map((c) => c.value);
  const job = startJob(
    choices.length,
    wordProbe(words, (i) => choices[i]),
  );
  while (!stepJob(job, budget)) {}
  return found(queryKey(words), job).order.map((i) => choices[i].value);
}

test("matching ignores accents and case, and searches the hint", () => {
  expect(shown(OPTIONS, "CAFE AGENT")).toEqual(["b"]);
  expect(shown(OPTIONS, "zoe local")).toEqual(["d"]);
});

test("matching needs every word, in any order", () => {
  expect(shown(OPTIONS, "cf01 cafe")).toEqual(["b"]);
  expect(shown(OPTIONS, "cafe zzz")).toEqual([]);
});

test("titles that start with the first word lead; each side keeps the options' order", () => {
  expect(shown(OPTIONS, "ca")).toEqual(["b", "c", "a", "d"]);
});

test("keywords are searched and never needed in the title", () => {
  const withAlias: Choice[] = [{ value: "x", title: "Zoë's agent", keywords: "zz-handle" }];
  expect(shown(withAlias, "zz-handle")).toEqual(["x"]);
});

test("an empty query keeps every option in order", () => {
  expect(shown(OPTIONS, "  ")).toEqual(["a", "b", "c", "d"]);
});

test("a scan cut into slices finds what one pass finds, and every slice moves forward", () => {
  const many: Choice[] = [];
  for (let i = 0; i < 1000; i++) many.push({ value: `v${i}`, title: i % 7 === 0 ? `Café ${i}` : `Gate ${i}` });
  let tick = 0;
  const clock = () => (tick += 1);
  const job = startJob(
    many.length,
    wordProbe(queryWords("cafe"), (i) => many[i]),
  );
  let slices = 0;
  while (!stepJob(job, 3, clock)) slices++;
  expect(slices).toBeGreaterThan(1);
  expect(job.matched.length).toBe(143);
  expect(shown(many, "cafe")).toEqual(found("cafe", job).order.map((i) => many[i].value));
});

test("a zero budget still advances, so a scan always ends", () => {
  const job = startJob(
    OPTIONS.length,
    wordProbe(queryWords("ca"), (i) => OPTIONS[i]),
  );
  expect(stepJob(job, 0, () => 0)).toBe(true);
});

test("a longer query scans only what the shorter one matched; Backspace scans nothing", () => {
  const refiner = createRefiner();
  const words = (q: string) => queryKey(queryWords(q));
  expect(refiner.lookup(words("ca"))).toEqual({ exact: undefined, source: undefined });
  const job = startJob(
    OPTIONS.length,
    wordProbe(queryWords("ca"), (i) => OPTIONS[i]),
  );
  stepJob(job, 10);
  refiner.keep(found(words("ca"), job));
  expect(refiner.lookup(words("cafe ag")).source).toEqual([0, 1, 2, 3]);
  const narrow = startJob(
    OPTIONS.length,
    wordProbe(queryWords("cafe ag"), (i) => OPTIONS[i]),
    [0, 1, 2, 3],
  );
  stepJob(narrow, 10);
  refiner.keep(found(words("cafe ag"), narrow));
  expect(narrow.matched).toEqual([1]);
  expect(refiner.lookup(words("ca")).exact?.matched).toEqual([0, 1, 2, 3]);
  expect(refiner.lookup(words("x")).source).toBeUndefined();
});

test("a query that is not an extension does not reuse an earlier answer", () => {
  const refiner = createRefiner();
  refiner.keep({ key: "ca", matched: [0], order: [0] });
  expect(refiner.lookup("c a")).toEqual({ exact: undefined, source: undefined });
});

test("groups gather their options under a heading, in the order groups first appear", () => {
  const choices: Choice[] = [
    { value: "1", title: "A", group: "Local" },
    { value: "2", title: "B", group: "Cloud" },
    { value: "3", title: "C", group: "Local" },
    { value: "4", title: "D" },
  ];
  const groups = groupChoices(choices)!;
  const l = layout([0, 1, 2, 3], groups, -1);
  expect(l.order).toEqual([0, 2, 1, 3]);
  expect(l.rows).toEqual([-1, 0, 1, -2, 2, 3]);
  expect(groupChoices(OPTIONS)).toBeUndefined();
});

test("a limit keeps the best matches, not the first groups, and says how many were left out", () => {
  const choices: Choice[] = [
    { value: "1", title: "A", group: "X" },
    { value: "2", title: "B", group: "Y" },
    { value: "3", title: "C", group: "X" },
  ];
  const l = layout([2, 1, 0], groupChoices(choices), 2);
  expect(l.hidden).toBe(1);
  expect(l.order.slice().sort()).toEqual([1, 2]);
  expect(layout([0, 1, 2], undefined, -1).hidden).toBe(0);
  expect(layout([0, 1, 2], undefined, 0).order).toEqual([]);
});

test("revealing scrolls the least: up to the row's top, down to its bottom, and the first of a group brings its heading", () => {
  const plain = layout([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], undefined, -1);
  expect(revealOffset(plain, 3, 0, 224)).toBeUndefined();
  expect(revealOffset(plain, 9, 0, 224)).toBe(10 * ROW_H - 224);
  expect(revealOffset(plain, 1, 100, 224)).toBe(ROW_H);
  const choices: Choice[] = [
    { value: "1", title: "A", group: "X" },
    { value: "2", title: "B", group: "X" },
    { value: "3", title: "C", group: "Y" },
  ];
  const grouped = layout([0, 1, 2], groupChoices(choices), -1);
  expect(rowOf(grouped, 2)).toBe(4);
  // Row 3 is Y's heading (HEAD_H tall, below the heading of X and two rows): arriving at C from below brings it into view.
  expect(revealOffset(grouped, 2, 120, 64)).toBe(HEAD_H + 2 * ROW_H);
});

const walk = (count: number, from: number, dir: 1 | -1, o: Partial<Parameters<typeof nextHighlight>[3]> = {}) =>
  nextHighlight(count, from, dir, { loop: true, escape: false, ...o });

test("Down and Up wrap past the ends", () => {
  expect(walk(3, -1, 1)).toBe(0);
  expect(walk(3, 2, 1)).toBe(0);
  expect(walk(3, -1, -1)).toBe(2);
  expect(walk(3, 0, -1)).toBe(2);
});

test("with escape, the step past an end leaves the list for the input, and the next one enters at the far end", () => {
  expect(walk(3, 2, 1, { escape: true })).toBe(-1);
  expect(walk(3, -1, 1, { escape: true })).toBe(0);
  expect(walk(3, 0, -1, { escape: true })).toBe(-1);
  expect(walk(3, -1, -1, { escape: true })).toBe(2);
});

test("without loop the highlight stops at the ends", () => {
  expect(walk(3, 2, 1, { loop: false })).toBe(2);
  expect(walk(3, 0, -1, { loop: false })).toBe(0);
});

test("disabled positions are skipped, including at the ends, and an all-disabled list highlights nothing", () => {
  const off = (p: number) => p === 1 || p === 3;
  expect(walk(5, 0, 1, { disabled: off })).toBe(2);
  expect(walk(5, 4, -1, { disabled: off })).toBe(2);
  expect(walk(5, 4, 1, { disabled: off })).toBe(0);
  expect(walk(4, 2, 1, { disabled: off })).toBe(0);
  expect(walk(2, -1, 1, { disabled: () => true })).toBe(-1);
  expect(walk(0, -1, 1)).toBe(-1);
});

test("PageDown and PageUp move a page and stop at the ends", () => {
  expect(pageHighlight(100, -1, 1, 7)).toBe(6);
  expect(pageHighlight(100, 95, 1, 7)).toBe(99);
  expect(pageHighlight(100, 3, -1, 7)).toBe(0);
  expect(pageHighlight(100, -1, -1, 7)).toBe(93);
  expect(pageHighlight(20, 0, 1, 7, (p) => p === 7)).toBe(8);
});

test("the list opens on the chosen option; typing starts from the first one only with autoHighlight", () => {
  const base = { count: 10, chosen: [4, 2], typing: false, auto: false as const };
  expect(initialHighlight(base)).toBe(2);
  expect(initialHighlight({ ...base, chosen: [] })).toBe(-1);
  expect(initialHighlight({ ...base, chosen: [], auto: "always" })).toBe(0);
  expect(initialHighlight({ ...base, chosen: [], auto: "input-change" })).toBe(-1);
  expect(initialHighlight({ ...base, typing: true, auto: "input-change" })).toBe(0);
  expect(initialHighlight({ ...base, typing: true })).toBe(-1);
  expect(initialHighlight({ ...base, count: 0, auto: "always" })).toBe(-1);
  expect(initialHighlight({ ...base, chosen: [], auto: "always", disabled: (p) => p < 2 })).toBe(2);
});

test("the input shows the chosen title again after a close, a clear and a single pick; a multiple pick keeps the filter until the list closes", () => {
  const typed = "cafe";
  const state = { typed, multiple: false, open: true };
  expect(reconcileTyped({ ...state, event: "type", text: "cafe a" })).toBe("cafe a");
  expect(reconcileTyped({ ...state, event: "close" })).toBeUndefined();
  expect(reconcileTyped({ ...state, event: "clear" })).toBeUndefined();
  expect(reconcileTyped({ ...state, event: "pick" })).toBeUndefined();
  expect(reconcileTyped({ ...state, multiple: true, event: "pick" })).toBe("cafe");
  expect(reconcileTyped({ ...state, multiple: true, event: "close" })).toBeUndefined();
});

test("a value that changes under an open field keeps what the user is typing, a closed one follows it", () => {
  expect(reconcileTyped({ event: "value", typed: "cafe", multiple: false, open: true })).toBe("cafe");
  expect(reconcileTyped({ event: "value", typed: "cafe", multiple: false, open: false })).toBeUndefined();
});

test("a filter is asked nothing while the input still shows the chosen title", () => {
  expect(filterQuery(undefined, "stale")).toBe("");
  expect(filterQuery("cafe", "cafe")).toBe("cafe");
});

test("typing opens the list; half-composed or emptied text does not close it unless clicks do not open it", () => {
  const typing = { composing: false, openOnInputClick: true, readOnly: false };
  expect(typingOpens({ ...typing, text: "h" })).toBe("open");
  expect(typingOpens({ ...typing, text: "  " })).toBe("keep");
  expect(typingOpens({ ...typing, text: "", openOnInputClick: false })).toBe("close");
  expect(typingOpens({ ...typing, text: "", openOnInputClick: false, composing: true })).toBe("keep");
  expect(typingOpens({ ...typing, text: "h", readOnly: true })).toBe("keep");
});

test("an Autocomplete rewrites the field only for the modes that complete, never for the pointer and never read-only", () => {
  expect(inlineText("both", "Café agent", "keyboard", false)).toBe("Café agent");
  expect(inlineText("inline", "Café agent", "none", false)).toBe("Café agent");
  expect(inlineText("list", "Café agent", "keyboard", false)).toBeUndefined();
  expect(inlineText("none", "Café agent", "keyboard", false)).toBeUndefined();
  expect(inlineText("both", "Café agent", "pointer", false)).toBeUndefined();
  expect(inlineText("both", "Café agent", "keyboard", true)).toBeUndefined();
  expect(inlineText("both", undefined, "keyboard", false)).toBeUndefined();
});

test("a multiple choice adds to the end, takes out what is there, and removes by position", () => {
  expect(toggleValue(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  expect(toggleValue(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  expect(removeAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  expect(removeAt(["a"], 5)).toEqual(["a"]);
});

test("after a chip is removed the cursor lands on the next chip, or the one before at the end, or nowhere", () => {
  expect(chipAfterRemoval(0, 3)).toBe(0);
  expect(chipAfterRemoval(2, 3)).toBe(1);
  expect(chipAfterRemoval(0, 1)).toBe(-1);
});

test("Left from the caret at the start enters at the last chip; Right past the last returns to the field", () => {
  expect(chipStep(-1, -1, 3)).toBe(2);
  expect(chipStep(2, -1, 3)).toBe(1);
  expect(chipStep(0, -1, 3)).toBe(0);
  expect(chipStep(1, 1, 3)).toBe(2);
  expect(chipStep(2, 1, 3)).toBe(-1);
  expect(chipStep(-1, 1, 3)).toBe(-1);
  expect(chipStep(-1, -1, 0)).toBe(-1);
});

test("a list is cut to the room beside its field, less its chrome and the more-results line, and keeps a row", () => {
  expect(listRoom(300, false)).toBe(290);
  expect(listRoom(300, true)).toBe(262);
  expect(listRoom(20, true)).toBe(ROW_H);
  expect(listRoom(Number.POSITIVE_INFINITY, false)).toBe(Number.POSITIVE_INFINITY);
});

test("a one-line input draws its own value only at rest and only when there is one", () => {
  expect(drawsOwnValue({ text: "build-box-eu-west-2 (staging cluster, shared)", focused: false })).toBe(true);
  expect(drawsOwnValue({ text: "build-box-eu-west-2 (staging cluster, shared)", focused: true })).toBe(false);
  expect(drawsOwnValue({ text: "", focused: false })).toBe(false);
});

test("a value is cut off when its lines hold fewer letters than it, spaces a break dropped not counted", () => {
  const full = "build-box-eu-west-2 (staging cluster, shared)";
  expect(isCutOff(["build-box-eu-west-2 (staging cluster, shared)"], full)).toBe(false);
  expect(isCutOff(["build-box-eu-west-2 (staging", "cluster, shared)"], full)).toBe(false);
  expect(isCutOff(["build-box-eu-west-2 (stag…"], full)).toBe(true);
});
