/**
 * What a screen reader says for a tab: `<title>, <state>, tab 3 of 8`. The state is left out for a tab that has none
 * (the board, Changes). The tab's own text is cut with an ellipsis when it does not fit, so this is the whole of it.
 */
export function tabLabel(title: string, state: string, index: number, count: number): string {
  return [title, state, `tab ${index + 1} of ${count}`].filter(Boolean).join(", ");
}
