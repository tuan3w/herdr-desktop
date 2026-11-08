/**
 * What a chat row works out from its text, kept by that text so a recycled list cell shown the same message again (scrolled
 * away and back) does not work it out again: the Markdown split into prose and fences (`splitFences`), a code block's
 * language and line count (`Code.describe`, `lineCount`). Bounded: the newest `size` entries by use, so a long session
 * holds a few hundred messages' worth and never grows with the conversation. Keys are the text itself (a JS string
 * compare and hash, no copy); a message still being written changes its text with every chunk, so it misses and its stale
 * entries age out.
 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly size: number) {}

  /** The value for `key`, made by `make` the first time; a hit becomes the newest. */
  get(key: K, make: () => V): V {
    const map = this.map;
    if (map.has(key)) {
      const hit = map.get(key) as V;
      map.delete(key);
      map.set(key, hit);
      return hit;
    }
    const made = make();
    map.set(key, made);
    if (map.size > this.size) map.delete(map.keys().next().value as K);
    return made;
  }

  get count(): number {
    return this.map.size;
  }
}

/** Messages whose Markdown parts are kept: a few screens of a chat, up and down, in every open chat. */
export const MARKDOWN_ENTRIES = 512;
/** Code blocks whose language and line count are kept. */
export const CODE_ENTRIES = 512;
