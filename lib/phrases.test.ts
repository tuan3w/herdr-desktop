import { expect, test } from "nsh/test";

import {
  addPhrase,
  cleanPhrase,
  DEFAULT_PHRASES,
  emptyPhrases,
  learn,
  learnedChips,
  type Learned,
  MAX_CHIPS,
  MAX_COUNT,
  MAX_LENGTH,
  MAX_TRACKED,
  normalizePhrases,
  ownPhrases,
  parsePhrases,
  phraseProblem,
  quickChips,
  removePhrase,
  replacePhrase,
} from "#lib/phrases";

/** The quick phrases and what the composer learns, ported from herdr-mobile's `quick_phrases_test` and `sent_phrases_test`. */
const sendTimes = (text: string, times: number, from: Learned[] = []): Learned[] => {
  let learned = from;
  for (let i = 0; i < times; i++) learned = learn(learned, text);
  return learned;
};

test("a phrase is stored on one line, trimmed and cut to 80 characters", () => {
  expect(cleanPhrase("  run   the\n tests  ")).toBe("run the tests");
  expect(cleanPhrase("x".repeat(100))).toBe("x".repeat(MAX_LENGTH));
  expect(cleanPhrase("   ")).toBe("");
  // Cut by characters, not by UTF-16 units: an emoji is not split.
  expect([...cleanPhrase("😀".repeat(100))].length).toBe(MAX_LENGTH);
});

test("a list drops empties and repeats and keeps at most twelve", () => {
  expect(normalizePhrases(["a", " a ", "", "b"])).toEqual(["a", "b"]);
  expect(normalizePhrases(Array.from({ length: 20 }, (_, i) => `p${i}`)).length).toBe(MAX_COUNT);
});

test("the person's list starts as the shipped phrases and a change makes it theirs", () => {
  const fresh = emptyPhrases();
  expect(ownPhrases(fresh)).toEqual(DEFAULT_PHRASES);
  const added = addPhrase(fresh, "ship it");
  expect(ownPhrases(added)).toEqual([...DEFAULT_PHRASES, "ship it"]);
  expect(added.own).not.toBeNull();
});

test("a phrase that is empty, already there or one too many is refused with its reason, and nothing changes", () => {
  const list = ["a", "b"];
  expect(phraseProblem(list, "  ")).toBe("empty");
  expect(phraseProblem(list, "a")).toBe("duplicate");
  expect(phraseProblem(list, "c")).toBeNull();
  expect(
    phraseProblem(
      Array.from({ length: MAX_COUNT }, (_, i) => `p${i}`),
      "new",
    ),
  ).toBe("full");
  // An edit that changes nothing is fine; replacing is allowed in a full list.
  expect(phraseProblem(list, "a", "a")).toBeNull();
  expect(
    phraseProblem(
      Array.from({ length: MAX_COUNT }, (_, i) => `p${i}`),
      "new",
      "p3",
    ),
  ).toBeNull();

  const memory = { own: ["a"], learned: [] };
  expect(addPhrase(memory, "a")).toBe(memory);
  expect(replacePhrase(memory, "missing", "x")).toBe(memory);
  expect(removePhrase(memory, "missing")).toBe(memory);
  expect(replacePhrase(memory, "a", "z").own).toEqual(["z"]);
  expect(removePhrase(memory, "a").own).toEqual([]);
});

test("a message sent once is not a chip; sent twice it is", () => {
  expect(learnedChips(sendTimes("ship it now", 1))).toEqual([]);
  expect(learnedChips(sendTimes("ship it now", 2))).toEqual(["ship it now"]);
});

test("what may never be learned: a command, an address, a secret-looking token, several lines, nearly nothing, a long line", () => {
  for (const text of [
    "/compact",
    "see https://example.com/x",
    "token ghp_1234567890abcdefghij1234",
    "two\nlines",
    "a",
    "x ".repeat(60),
  ]) {
    expect(sendTimes(text, 3)).toEqual([]);
  }
});

test("the same message in another case or with spaces around counts as one", () => {
  const learned = learn(learn([], "Run the tests"), "  run the TESTS ");
  expect(learned.length).toBe(1);
  expect(learned[0].n).toBe(2);
  expect(learned[0].t).toBe("run the TESTS");
});

test("learned chips are the most sent first, at most three, and leave out the person's own", () => {
  let learned = sendTimes("alpha", 2);
  learned = sendTimes("beta", 5, learned);
  learned = sendTimes("gamma", 3, learned);
  learned = sendTimes("delta", 2, learned);
  learned = sendTimes("epsilon", 4, learned);
  expect(learnedChips(learned)).toEqual(["beta", "epsilon", "gamma"]);
  expect(learnedChips(learned).length).toBeLessThanOrEqual(MAX_CHIPS);
  expect(learnedChips(learned, ["BETA"])).toEqual(["epsilon", "gamma", "delta"]);
  // Equal counts: the later one first.
  expect(learnedChips(sendTimes("two", 2, sendTimes("one", 2)))).toEqual(["two", "one"]);
});

test("only 300 are remembered, the rarest and oldest dropped first", () => {
  let learned: Learned[] = [];
  for (let i = 0; i < MAX_TRACKED + 40; i++) learned = learn(learned, `message number ${i}`);
  expect(learned.length).toBe(MAX_TRACKED);
  // Everything was sent once: the oldest went.
  expect(learned.some((e) => e.t === "message number 0")).toBe(false);
  expect(learned.some((e) => e.t === `message number ${MAX_TRACKED + 39}`)).toBe(true);
  // A busy old one outlives newer ones that were sent once.
  const busy = sendTimes("busy old one", 4);
  let more = busy;
  for (let i = 0; i < MAX_TRACKED + 10; i++) more = learn(more, `filler ${i}`);
  expect(more.some((e) => e.t === "busy old one")).toBe(true);
});

test("while the list is the shipped one a message the person really sends goes first; an edited list keeps its place", () => {
  const learned = sendTimes("ship it now", 2);
  expect(quickChips({ own: null, learned })).toEqual(["ship it now", ...DEFAULT_PHRASES]);
  expect(quickChips({ own: ["mine"], learned })).toEqual(["mine", "ship it now"]);
});

test("a phrase that is also learned shows once, where the order puts it first", () => {
  const learned = sendTimes("Continue", 3);
  expect(quickChips({ own: null, learned })).toEqual([
    "Continue",
    "yes, go ahead",
    "run the tests",
    "explain what you changed",
  ]);
  expect(quickChips({ own: ["continue", "x"], learned })).toEqual(["continue", "x"]);
});

test("what was saved comes back, and what does not fit is dropped", () => {
  const memory = { own: ["a", "b"], learned: sendTimes("ship it now", 2) };
  expect(parsePhrases(JSON.parse(JSON.stringify(memory)))).toEqual(memory);
  expect(parsePhrases({ own: "no", learned: "no" })).toEqual(emptyPhrases());
  const parsed = parsePhrases({
    own: ["ok", 3, "ok", ""],
    learned: [
      { t: "fine one", n: 2, l: 1 },
      { t: "/command", n: 9, l: 2 },
      { t: "zero", n: 0, l: 3 },
      { t: 5, n: 2, l: 4 },
      null,
      "x",
    ],
  });
  expect(parsed.own).toEqual(["ok"]);
  expect(parsed.learned).toEqual([{ t: "fine one", n: 2, l: 1 }]);
  for (const junk of [null, 3, "x", [], undefined]) expect(parsePhrases(junk)).toEqual(emptyPhrases());
});
