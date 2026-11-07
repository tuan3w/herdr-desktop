import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 1600, platform: "macos" } as const;

/**
 * The probe's stops of Tab, in order: Segmented, manual tabs, automatic tabs, the kept draft, radio group, `Approved`,
 * `Read only`, `Select all`, m1, m2, m3, the switch, the read-only switch, the collapsible, the two accordion triggers.
 * (A disabled control and a hidden panel are no stops.)
 */
async function tabTo(app: Awaited<ReturnType<typeof open>>, stop: number) {
  for (let i = 0; i < stop; i++) await app.keyboard.press("tab");
}

test("a segmented control is one stop of Tab: arrows choose and wrap, Home does nothing, and leaving it releases the keys", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  expect(app.texts()).toContain("seg=a");
  await tabTo(app, 1);
  await app.keyboard.press("right");
  expect(app.texts()).toContain("seg=b");
  await app.keyboard.press("right");
  await app.keyboard.press("right");
  expect(app.texts()).toContain("seg=a");
  await app.keyboard.press("left");
  expect(app.texts()).toContain("seg=c");
  await app.keyboard.press("home");
  expect(app.texts()).toContain("seg=c");
  await app.keyboard.press("tab");
  await app.keyboard.press("right");
  expect(app.texts()).toContain("seg=c");
  expect(app.texts()).toContain("manual=one");
});

test("a pointer press chooses a segment too", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await app.press("label:Two");
  expect(app.texts()).toContain("seg=b");
});

test("tabs: arrows move the highlight, Space or Return chooses, a disabled tab is reached but never chosen, Home and End jump", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await tabTo(app, 2);
  await app.keyboard.press("right");
  expect(app.texts()).toContain("manual=one");
  await app.keyboard.press("space");
  expect(app.texts()).toContain("manual=two");
  await app.keyboard.press("right");
  await app.keyboard.press("space");
  expect(app.texts()).toContain("manual=two");
  await app.keyboard.press("right");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("manual=one");
  await app.keyboard.press("end");
  await app.keyboard.press("home");
  await app.keyboard.press("right");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("manual=two");
});

test("with activateOnFocus the arrows choose as they go, and a kept panel keeps its field while an unkept one loses it", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await tabTo(app, 3);
  await app.keyboard.press("right");
  expect(app.texts()).toContain("auto=two");
  await app.keyboard.press("end");
  expect(app.texts()).toContain("auto=three");
  await app.press("label:/^Green/");
  await app.type("label:kept", "abc");
  await app.press("label:Red");
  await app.type("label:unkept", "xyz");
  await app.press("label:Yellow");
  expect(app.shows("label:unkept")).toBe(false);
  await app.press("label:Red");
  expect(app.value("label:unkept")).toBe("");
  await app.press("label:/^Green/");
  expect(app.value("label:kept")).toBe("abc");
});

test("a tab's name carries its count", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  expect(app.shows("label:Green, 3 items")).toBe(true);
});

test("a vertical radio group skips a disabled item, wraps, ignores the other axis, and Return chooses nothing", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await tabTo(app, 5);
  await app.keyboard.press("down");
  expect(app.texts()).toContain("runtime=remote");
  await app.keyboard.press("down");
  expect(app.texts()).toContain("runtime=local");
  await app.keyboard.press("right");
  expect(app.texts()).toContain("runtime=local");
  await app.keyboard.press("up");
  expect(app.texts()).toContain("runtime=remote");
  await expect(() => app.press("label:Cloud sandbox")).rejects.toThrow("disabled");
  expect(app.texts()).toContain("runtime=remote");
});

test("a checkbox toggles with Space and not with Return; read-only and disabled ones stay as they are", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await tabTo(app, 6);
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("ticked=false asked=0");
  await app.keyboard.press("space");
  expect(app.texts()).toContain("ticked=true asked=1");
  await app.keyboard.press("tab");
  await app.keyboard.press("space");
  await app.press("label:Read only");
  expect(app.enabled("label:Locked")).toBe(false);
  expect(app.texts()).toContain("ticked=true asked=1");
});

test("Return works again after the focus leaves a checkbox: it toggles a switch", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await tabTo(app, 12);
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("on=true");
});

test("select all over a partial selection: all, none, the hand-picked set again; a child press restarts the cycle", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  expect(app.texts()).toContain("picked=m1");
  await app.press("label:Select all");
  expect(app.texts()).toContain("picked=m1,m2,m3");
  await app.press("label:Select all");
  expect(app.texts()).toContain("picked=");
  await app.press("label:Select all");
  expect(app.texts()).toContain("picked=m1");
  expect(app.enabled("label:m4")).toBe(false);
  await app.press("label:m2");
  expect(app.texts()).toContain("picked=m1,m2");
  await app.press("label:Select all");
  expect(app.texts()).toContain("picked=m1,m2,m3");
});

test("a switch toggles on press, and a read-only one does not", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await app.press("label:Enable");
  expect(app.texts()).toContain("on=true");
  await app.press("label:Read only on");
  expect(app.texts()).toContain("on=true");
  await app.press("label:Enable");
  expect(app.texts()).toContain("on=false");
});

test("a collapsible shows its panel only while open; an accordion keeps one item open and can close it", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  expect(app.shows("text:detail body")).toBe(false);
  await app.press("label:Details");
  expect(app.shows("text:detail body")).toBe(true);
  await app.press("label:Details");
  expect(app.shows("text:detail body")).toBe(false);

  expect(app.shows("text:body x")).toBe(true);
  await app.press("label:Item Y");
  expect(app.shows("text:body x")).toBe(false);
  expect(app.shows("text:body y")).toBe(true);
  await app.press("label:Item Y");
  expect(app.shows("text:body y")).toBe(false);
});

test("an avatar is named when it has a label; an indeterminate bar exists only while it is shown and a determinate one speaks its value", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  expect(app.shows("label:Claude Code")).toBe(true);
  expect(app.shows("label:Progress")).toBe(true);
  expect(app.shows("label:Loading")).toBe(false);
  await app.press("label:Test run");
  expect(app.shows("label:Loading")).toBe(true);
  await app.press("label:Test run");
  expect(app.shows("label:Loading")).toBe(false);
});

test("a tab's panel is a region named by its tab, and only the shown one is listed", async () => {
  const app = await open("./controls-probe.tsx", DESKTOP);
  await app.waitFor("role:region");
  expect(app.shows("label:Green")).toBe(true);
  await app.press("label:Red");
  await app.waitUntil(() => app.shows("label:Red"));
});
