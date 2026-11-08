import { expect, test } from "nsh/test";

import { Lru } from "#lib/render-cache";

test("a kept value is made once, and the cache holds only its newest entries by use", () => {
  const cache = new Lru<string, number>(2);
  let made = 0;
  const make = (v: number) => () => {
    made++;
    return v;
  };
  expect(cache.get("a", make(1))).toBe(1);
  expect(cache.get("a", make(9))).toBe(1);
  expect(made).toBe(1);
  cache.get("b", make(2));
  // `a` is used again, so `b` is the oldest when `c` arrives.
  cache.get("a", make(9));
  cache.get("c", make(3));
  expect(cache.count).toBe(2);
  expect(cache.get("a", make(9))).toBe(1);
  expect(cache.get("b", make(4))).toBe(4);
  expect(made).toBe(4);
});
