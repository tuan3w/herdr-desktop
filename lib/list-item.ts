/**
 * What a recycled `List` cell shows when its item changes kind (a card becomes a header after a fold or a theme
 * switch): the old view is told the new item before the `If` swaps it out, so a view reads the last item of its own
 * kind and never a value that has no `row`.
 */
export function ofKind<I extends { kind: string }, K extends I["kind"]>(
  item: () => I,
  kind: K,
): () => Extract<I, { kind: K }> {
  let last: Extract<I, { kind: K }> | undefined;
  return () => {
    const now = item();
    if (now.kind === kind) last = now as Extract<I, { kind: K }>;
    return last!;
  };
}

/**
 * A prop that is cleared while its view is being taken down (`<If when={file()}>` sets the value to null before the
 * view's effects are disposed): the last real value is read instead of `null`, so nothing in the leaving view throws.
 */
export function held<T>(read: () => T | null | undefined): () => T {
  let last: T | undefined;
  return () => {
    const now = read();
    if (now !== null && now !== undefined) last = now;
    return last as T;
  };
}
