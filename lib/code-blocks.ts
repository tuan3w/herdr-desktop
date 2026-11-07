/**
 * The code block the person last pointed at or focused, so `Copy code` (a shortcut, a palette entry) can copy it without
 * a pointer. A block holds a getter of its text, not the text: a block that is still being written copies what it has
 * now. The last block of the last answer is the fallback when none was touched (`lib/session-copy.ts`).
 */
let current: (() => string) | undefined;

export const touched = {
  /** Makes `code` the block a copy command takes. */
  set(code: () => string): void {
    current = code;
  },
  /** A block that goes away stops being the one, unless another was touched since. */
  release(code: () => string): void {
    if (current === code) current = undefined;
  },
  /** The touched block's text, or `undefined` when none is (or it is empty). */
  text(): string | undefined {
    const t = current?.();
    return t === undefined || t === "" ? undefined : t;
  },
};
