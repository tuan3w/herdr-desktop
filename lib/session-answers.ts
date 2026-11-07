import type { FieldAnswerInput, QuestionFieldView } from "herdr-desktop/native";

/**
 * What the person has entered in the form of an agent's question, and how it becomes the answer. Validation is Rust's
 * (`Sessions.answerQuestion` refuses what does not pass and says which field and why); this only shapes the request and
 * puts the refusal where the person looks.
 */

/** What has been entered in one field. */
export interface FieldState {
  text: string;
  choice: number | null;
  ticked: number[];
}

/** The state a field starts in: the agent's own default. */
export function startState(field: QuestionFieldView): FieldState {
  return { text: field.text, choice: field.choice ?? null, ticked: [...field.ticked] };
}

/** The answer to `field` from what was entered; a field the app cannot show is left out, so the agent's default stands. */
export function answerOf(field: QuestionFieldView, state: FieldState): FieldAnswerInput {
  switch (field.kind) {
    case "text":
    case "number":
      return { text: state.text };
    case "choice":
    case "bool":
      return state.choice === null ? {} : { choice: state.choice };
    case "multi":
      return { ticked: state.ticked };
    default:
      return {};
  }
}

/**
 * Where a refusal of the form belongs. The engine words it `<field label>: <why>`; when a field's label starts it, that
 * field gets `why` under it. Anything else (more answers than fields, a message of another kind) has no field.
 */
export function placeRefusal(message: string, labels: readonly string[]): { field: number; why: string } | { field: null; why: string } {
  const at = labels.findIndex((label) => message.startsWith(`${label}: `));
  return at < 0 ? { field: null, why: message } : { field: at, why: message.slice(labels[at]!.length + 2) };
}
