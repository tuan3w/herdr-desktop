import { expect, test } from "nsh/test";

import { around, emptyHistory, HISTORY_CAP, pushPlace, previousOf, replacePlace, stepPlace } from "#lib/nav";
import type { History } from "#lib/nav";

const walk = (places: string[], at = places.length - 1): History => ({ places, at });
const all = () => true;

test("a command adds a step, going where you already are adds nothing, and a new step drops the way forward", () => {
  let h = pushPlace(pushPlace(emptyHistory(), "a"), "b");
  expect(pushPlace(h, "b")).toBe(h);
  h = pushPlace(h, "c");
  const back = stepPlace(h, -1, all)!;
  expect(back.place).toBe("b");
  expect(stepPlace(back.history, 1, all)!.place).toBe("c");
  // From b, going to d leaves c behind: forward has nothing.
  const branched = pushPlace(back.history, "d");
  expect(branched.places).toEqual(["a", "b", "d"]);
  expect(stepPlace(branched, 1, all)).toBeNull();
});

test("a click replaces where you are instead of adding a step, and a repeat of a neighbour collapses", () => {
  const h = replacePlace(walk(["a", "b"]), "c");
  expect(h).toEqual({ places: ["a", "c"], at: 1 });
  expect(replacePlace(h, "a")).toEqual({ places: ["a"], at: 0 });
  expect(replacePlace(emptyHistory(), "a")).toEqual({ places: ["a"], at: 0 });
});

test("the history keeps the newest fifty steps", () => {
  let h = emptyHistory();
  for (let i = 0; i < HISTORY_CAP + 20; i++) h = pushPlace(h, `p${i}`);
  expect(h.places).toHaveLength(HISTORY_CAP);
  expect(h.places[h.at]).toBe(`p${HISTORY_CAP + 19}`);
  expect(h.places[0]).toBe("p20");
});

test("back and forward skip a place whose agent is gone and stop at the ends", () => {
  const h = walk(["a", "gone", "c"]);
  const alive = (p: string) => p !== "gone";
  const first = stepPlace(h, -1, alive)!;
  expect(first.place).toBe("a");
  expect(stepPlace(first.history, -1, alive)).toBeNull();
  expect(stepPlace(first.history, 1, alive)!.place).toBe("c");
  expect(stepPlace(walk(["a", "gone"], 0), 1, alive)).toBeNull();
});

test("previous is the newest visit that is not here and still exists; with nothing else it is nothing", () => {
  const alive = (k: string) => k !== "gone";
  expect(previousOf(["b", "a", "c"], "b", alive)).toBe("a");
  expect(previousOf(["gone", "b", "a"], "b", alive)).toBe("a");
  expect(previousOf(["b", "a"], null, alive)).toBe("b");
  expect(previousOf(["b"], "b", alive)).toBeUndefined();
});

test("next and previous project wrap around, and from nowhere start at the ends", () => {
  const order = ["a", "b", "c"];
  expect(around(order, "c", 1)).toBe("a");
  expect(around(order, "a", -1)).toBe("c");
  expect(around(order, null, 1)).toBe("a");
  expect(around(order, null, -1)).toBe("c");
  expect(around(order, "zzz", 1)).toBe("a");
  expect(around([], "a", 1)).toBeUndefined();
});
