/**
 * What a recycled `List` cell shows when its item changes kind (a card becomes a header after a fold or a theme
 * switch): the old view is told the new item before the `If` swaps it out, so a view reads the last item of its own
 * kind and never a value that has no `row`.
 */
export function ofKind<I extends { kind: string }, K extends I["kind"]>(item: () => I, kind: K): () => Extract<I, { kind: K }> {
  let last: Extract<I, { kind: K }> | undefined;
  return () => {
    const now = item();
    if (now.kind === kind) last = now as Extract<I, { kind: K }>;
    return last!;
  };
}
