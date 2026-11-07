import { expect, test } from "nsh/test";
import type { QuestionFieldView } from "herdr-desktop/native";
import { answerOf, placeRefusal, startState } from "./session-answers";

const field = (over: Partial<QuestionFieldView>): QuestionFieldView => ({ name: "n", label: "N", required: false, secret: false, kind: "text", integer: false, choices: [], text: "", ticked: [], ...over });

test("each kind of field answers in the shape the engine takes, and a field the app cannot show is left to the agent", () => {
  expect(answerOf(field({ kind: "text" }), { text: "hi", choice: null, ticked: [] })).toEqual({ text: "hi" });
  expect(answerOf(field({ kind: "number" }), { text: "3", choice: null, ticked: [] })).toEqual({ text: "3" });
  expect(answerOf(field({ kind: "choice" }), { text: "", choice: 1, ticked: [] })).toEqual({ choice: 1 });
  expect(answerOf(field({ kind: "bool" }), { text: "", choice: 0, ticked: [] })).toEqual({ choice: 0 });
  expect(answerOf(field({ kind: "multi" }), { text: "", choice: null, ticked: [0, 2] })).toEqual({ ticked: [0, 2] });
  // Nothing picked is not "the first one": it is no answer, so the agent's own default stands.
  expect(answerOf(field({ kind: "choice" }), { text: "", choice: null, ticked: [] })).toEqual({});
  expect(answerOf(field({ kind: "unsupported" }), { text: "x", choice: 1, ticked: [1] })).toEqual({});
});

test("a form starts from what the agent proposed, without sharing its lists", () => {
  const proposed = field({ kind: "multi", ticked: [1], text: "x", choice: 0 });
  const state = startState(proposed);
  expect(state).toEqual({ text: "x", choice: 0, ticked: [1] });
  state.ticked.push(2);
  expect(proposed.ticked).toEqual([1]);
});

test("a refusal goes under the field it names, and a general one under the buttons", () => {
  expect(placeRefusal("How many: At least 1", ["Name", "How many"])).toEqual({ field: 1, why: "At least 1" });
  expect(placeRefusal("More answers than fields", ["Name"])).toEqual({ field: null, why: "More answers than fields" });
});
