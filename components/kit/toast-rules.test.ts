import { expect, test } from "nsh/test";
import { createToasts, liveUndos, newestUndo, type ToastInput, type Toasts, type UndoEntry } from "./toast-rules";

const EXIT = 160;

function toasts(options: { limit?: number; timeout?: number } = {}): Toasts<string> {
  return createToasts<string>({ limit: options.limit ?? 3, keep: 30, timeout: options.timeout ?? 5000, exitMs: () => EXIT });
}

const input = (text: string, rest: Partial<ToastInput<string>> = {}): ToastInput<string> => ({ text, data: text, ...rest });
const status = (t: Toasts<string>, id: string) => t.get(id)?.status ?? "gone";

test("a toast closes after its running time, then leaves after the exit", () => {
  const t = toasts();
  const { id } = t.add(input("a", { id: "a" }), 0);
  expect(t.advance(4999).closed).toEqual([]);
  expect(t.advance(5000).closed.map((x) => x.id)).toEqual([id]);
  expect(status(t, "a")).toBe("ending");
  expect(t.advance(5000 + EXIT - 1).removed).toEqual([]);
  expect(t.advance(5000 + EXIT).removed.map((x) => x.id)).toEqual(["a"]);
  expect(status(t, "a")).toBe("gone");
});

test("paused time is not running time: repeated pauses never hand a toast extra time", () => {
  const t = toasts();
  t.add(input("a", { id: "a" }), 0);
  // two cycles, each running 1000 ms and paused 1000 ms: 2000 of 5000 are used
  let now = 0;
  for (let cycle = 0; cycle < 2; cycle += 1) {
    now += 1000;
    t.pause("hover", now);
    now += 1000;
    t.resume("hover", now);
  }
  expect(t.advance(now + 2999).closed).toEqual([]);
  expect(t.advance(now + 3000).closed.map((x) => x.id)).toEqual(["a"]);
});

test("the timers stay still until every reason has let go, and a toast added meanwhile starts paused", () => {
  const t = toasts();
  t.add(input("a", { id: "a" }), 0);
  t.pause("hover", 1000);
  t.pause("focus", 1500);
  t.add(input("b", { id: "b" }), 2000);
  t.resume("hover", 3000);
  // focus still holds: a keeps its 4000 ms, b its 5000
  expect(t.advance(60000).closed).toEqual([]);
  t.resume("focus", 60000);
  expect(t.nextDue(60000)).toBe(4000);
  expect(t.advance(64000).closed.map((x) => x.id)).toEqual(["a"]);
  expect(t.advance(65000).closed.map((x) => x.id)).toEqual(["b"]);
});

test("pausing after the time is already up closes the toast: it expired, it is not given a new full time", () => {
  const t = toasts();
  t.add(input("a", { id: "a" }), 0);
  t.pause("hover", 60000);
  expect(status(t, "a")).toBe("ending");
});

test("the reasons are cleared with the last toast, so the next one is not born paused", () => {
  const t = toasts();
  t.add(input("a", { id: "a" }), 0);
  t.pause("hover", 100);
  t.close(undefined, 200);
  t.advance(200 + EXIT);
  expect(t.all().length).toBe(0);
  expect(t.paused()).toBe(false);
  t.add(input("b", { id: "b" }), 1000);
  expect(t.advance(6000).closed.map((x) => x.id)).toEqual(["b"]);
});

test("a toast with timeout 0 or a loading one stays; a loading one starts its own time when it turns into a result", () => {
  const t = toasts();
  t.add(input("stays", { id: "stays", timeout: 0 }), 0);
  t.add(input("busy", { id: "busy", type: "loading", timeout: 1000 }), 0);
  expect(t.advance(1_000_000).closed).toEqual([]);
  expect(t.nextDue(1_000_000)).toBe(null);
  // the result does not inherit the loading toast's timeout: the default applies
  t.update("busy", { text: "done", type: "success", timeout: undefined }, 1_000_000);
  expect(t.get("busy")?.timeout).toBe(5000);
  expect(t.advance(1_004_999).closed).toEqual([]);
  expect(t.advance(1_005_000).closed.map((x) => x.id)).toEqual(["busy"]);
});

test("an update that does not name a timeout leaves the running timer alone; one that names it restarts it", () => {
  const t = toasts();
  t.add(input("a", { id: "a" }), 0);
  t.update("a", { text: "a, edited" }, 3000);
  expect(t.nextDue(3000)).toBe(2000);
  t.update("a", { timeout: 5000 }, 3000);
  expect(t.nextDue(3000)).toBe(5000);
});

test("an answer that arrives after the toast was closed or removed does not bring it back", () => {
  const t = toasts();
  t.add(input("a", { id: "a", type: "loading" }), 0);
  t.close("a", 10);
  expect(t.update("a", { text: "done", type: "success" }, 20).done).toBe(false);
  expect(status(t, "a")).toBe("ending");
  t.advance(10 + EXIT);
  expect(t.update("a", { text: "done" }, 500).done).toBe(false);
  expect(t.all().length).toBe(0);
});

test("past the limit the oldest are hidden but alive, and show again when a newer one goes", () => {
  const t = toasts({ limit: 2 });
  for (const id of ["a", "b", "c"]) t.add(input(id, { id }), 0);
  expect(t.shown().map((x) => x.id)).toEqual(["b", "c"]);
  expect(t.get("a")?.limited).toBe(true);
  t.close("c", 100);
  // c is still leaving, and a already takes its place
  expect(t.shown().map((x) => x.id)).toEqual(["a", "b", "c"]);
  expect(t.get("a")?.limited).toBe(false);
});

test("a hidden toast keeps counting down, so it can end without ever having shown", () => {
  const t = toasts({ limit: 1 });
  t.add(input("old", { id: "old", timeout: 1000 }), 0);
  t.add(input("new", { id: "new", timeout: 0 }), 10);
  expect(t.get("old")?.limited).toBe(true);
  expect(t.advance(1000).closed.map((x) => x.id)).toEqual(["old"]);
});

test("a high priority toast is not pushed out by newer low ones", () => {
  const t = toasts({ limit: 2 });
  t.add(input("warn", { id: "warn", priority: "high", timeout: 0 }), 0);
  for (const id of ["x", "y", "z"]) t.add(input(id, { id }), 0);
  expect(t.shown().map((x) => x.id)).toEqual(["warn", "z"]);
});

test("the same id is one toast: it updates in place, restarts its time, and keeps its place", () => {
  const t = toasts();
  t.add(input("first", { id: "a" }), 0);
  t.add(input("other", { id: "b" }), 100);
  const again = t.add(input("first, again", { id: "a" }), 4000);
  expect(again.replaced).toBe(true);
  expect(t.all().map((x) => x.id)).toEqual(["a", "b"]);
  expect(t.get("a")?.text).toBe("first, again");
  expect(t.get("a")?.version).toBe(1);
  expect(t.nextDue(4000)).toBe(1100);
});

test("adding an id that is closing replaces it with a new toast and reports nothing removed", () => {
  const t = toasts();
  t.add(input("a", { id: "a" }), 0);
  t.close("a", 50);
  const added = t.add(input("a, new", { id: "a" }), 60);
  expect(added.replaced).toBe(false);
  expect(added.settled.removed).toEqual([]);
  expect(t.get("a")?.status).toBe("present");
  expect(t.advance(60 + EXIT).removed).toEqual([]);
});

test("closing all marks every toast, and one that already closes is not reported twice", () => {
  const t = toasts();
  t.add(input("a", { id: "a" }), 0);
  t.add(input("b", { id: "b" }), 0);
  expect(t.close("a", 10).closed.map((x) => x.id)).toEqual(["a"]);
  expect(t.close(undefined, 20).closed.map((x) => x.id)).toEqual(["b"]);
  expect(t.close("missing", 30).closed).toEqual([]);
});

test("Cmd+Z reaches the newest undo whose toast is on screen or whose time has not run out", () => {
  const run = () => {};
  const entries: UndoEntry[] = [
    { id: "old", run, until: 1000 },
    { id: "hidden", run, until: 5000 },
    { id: "shown", run, until: 2000 },
  ];
  const onScreen = (id: string) => id === "shown";
  expect(newestUndo(entries, 100, onScreen)?.id).toBe("shown");
  // the newest toast is still on screen after its time: pressing its button is allowed, so is the shortcut
  expect(newestUndo(entries, 9000, onScreen)?.id).toBe("shown");
  // dismissed by Escape: the shortcut still works inside the time
  expect(newestUndo(entries, 3000, () => false)?.id).toBe("hidden");
  expect(newestUndo(entries, 6000, () => false)).toBe(undefined);
  expect(liveUndos(entries, 3000, () => false).map((e) => e.id)).toEqual(["hidden"]);
});

test("a loop that raises thousands of toasts keeps the newest few and tells the owners of the ones it dropped", () => {
  const t = toasts({ limit: 3 });
  const dropped: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const added = t.add(input(`t${i}`, { id: `t${i}`, timeout: 0 }), 0);
    for (const gone of added.settled.removed) dropped.push(gone.id);
  }
  expect(t.all().length).toBe(30);
  expect(t.shown().map((x) => x.id)).toEqual(["t97", "t98", "t99"]);
  expect(dropped.length).toBe(70);
  const more = t.add(input("one more", { id: "more", timeout: 0 }), 0);
  expect(more.settled.closed.map((x) => x.id)).toEqual(["t70"]);
  expect(more.settled.removed.map((x) => x.id)).toEqual(["t70"]);
  // a warning among them is never the one dropped
  const warn = toasts({ limit: 1 });
  warn.add(input("warn", { id: "warn", priority: "high", timeout: 0 }), 0);
  for (let i = 0; i < 40; i += 1) warn.add(input(`t${i}`, { id: `t${i}`, timeout: 0 }), 0);
  expect(warn.get("warn")?.status).toBe("present");
});
