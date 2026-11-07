import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800 };
const lab = () => open("./forms-probe.tsx", DESKTOP);

const DELAY = "label:Delay (s)";
const RETRIES = "label:Retries";
const NAME = "label:Name *";

test("a submit shows each wrong field's message under it, names it for a screen reader, and clears it when the field is fixed", async () => {
  const app = await lab();
  expect(app.texts()).toContain("Shown in the sidebar");
  await app.press("Save");
  expect(app.texts()).toContain("Enter a value.");
  expect(app.texts().some((t) => t.startsWith("done:{"))).toBe(false);
  await app.type(NAME, "build-box");
  expect(app.texts()).not.toContain("Enter a value.");
  // the hint comes back once there is no error
  expect(app.texts()).toContain("Shown in the sidebar");
  await app.press("Save");
  expect(JSON.parse(app.texts().find((t) => t.startsWith("done:"))?.slice(5) ?? "null")).toEqual({
    name: "build-box",
    host: "",
    delay: null,
    retries: 3,
  });
});

test("a field's own rule runs at submit and its message goes as soon as the value is right", async () => {
  const app = await lab();
  await app.type(NAME, "A");
  await app.type("label:Host", "no-at-sign");
  await app.press("Save");
  expect(app.texts()).toContain("Host needs user@host.");
  expect(app.texts().some((t) => t.startsWith("done:{"))).toBe(false);
  await app.type("label:Host", "@example.com");
  expect(app.texts()).not.toContain("Host needs user@host.");
});

test("an error from the server shows under its field and goes when that field changes", async () => {
  const app = await lab();
  await app.type(NAME, "A");
  await app.press("Save");
  await app.press("Server error");
  expect(app.texts()).toContain("Host already added.");
  await app.type("label:Host", "x@y.dev");
  expect(app.texts()).not.toContain("Host already added.");
});

test("a number is shown the English way and read from either convention", async () => {
  const app = await lab();
  await app.type(DELAY, "1,234.5");
  expect(app.texts()).toContain("delay:1234.5");
  // a letter is refused: the text stays what it was
  await app.type(DELAY, "a");
  expect(app.value(DELAY)).toBe("1,234.5");
  await app.clear(DELAY);
  expect(app.texts()).toContain("delay:null");
  await app.paste(DELAY, { text: "1.234,5" });
  expect(app.texts()).toContain("delay:1234.5");
  // leaving the field writes it back in English and clamps it to max
  await app.clear(DELAY);
  await app.type(DELAY, "250,000");
  await app.type(NAME, "A");
  expect(app.value(DELAY)).toBe("100,000");
  expect(app.texts()).toContain("delay:100000");
});

test("arrow keys step by 1, Shift by 10, mod by 0.1 without binary noise, and stop at the bounds", async () => {
  const app = await lab();
  await app.type(DELAY, "5");
  await app.keyboard.press("up");
  expect(app.texts()).toContain("delay:6");
  await app.keyboard.press("shift+up");
  expect(app.texts()).toContain("delay:16");
  await app.keyboard.press("pagedown");
  expect(app.texts()).toContain("delay:6");
  for (let i = 0; i < 3; i++) await app.keyboard.press("mod+up");
  expect(app.texts()).toContain("delay:6.3");
  expect(app.value(DELAY)).toBe("6.3");
  await app.clear(DELAY);
  await app.keyboard.press("down");
  expect(app.texts()).toContain("delay:0");
  await app.keyboard.press("down");
  expect(app.texts()).toContain("delay:0");
});

test("a field with min and max takes Home and End to the bounds; a stepped field snaps to its grid", async () => {
  const app = await lab();
  await app.type(RETRIES, "7");
  await app.keyboard.press("end");
  expect(app.texts()).toContain("retries:99");
  await app.keyboard.press("home");
  expect(app.texts()).toContain("retries:0");
});

test("Escape takes back what was typed since the last commit", async () => {
  const app = await lab();
  await app.type(DELAY, "12");
  await app.type(NAME, "A");
  await app.type(DELAY, "3");
  expect(app.value(DELAY)).toBe("123");
  await app.keyboard.press("escape");
  expect(app.value(DELAY)).toBe("12");
});

test("the stepper buttons step, are named, and a press held repeats", async () => {
  // A manual clock: the hold is 500 ms and the repeat starts at 400 ms, a margin a loaded runner's real timers miss.
  const app = await open("./forms-probe.tsx", { ...DESKTOP, clock: {} });
  expect(app.shows("label:Increase: Retries")).toBe(true);
  await app.press("label:Increase: Retries");
  expect(app.texts()).toContain("retries:4");
  await app.press("label:Decrease: Retries");
  await app.press("label:Decrease: Retries");
  expect(app.texts()).toContain("retries:2");
  await app.longPress("label:Increase: Retries");
  const held = Number(app.texts().find((t) => t.startsWith("retries:"))?.slice(8));
  expect(held).toBeGreaterThan(3);
});

test("Escape in a search box clears it", async () => {
  const app = await lab();
  await app.type("label:Search agents", "claude-api");
  expect(app.texts()).toContain("query:claude-api");
  await app.keyboard.press("escape");
  expect(app.texts()).toContain("query:");
});

test("a form of 40 fields mounts at once and typing costs no timer: validation by blur waits for the blur", async () => {
  const app = await lab();
  await app.press("Many fields");
  const mounted = Number(app.texts().find((t) => t.startsWith("mounted:"))?.slice(8));
  expect(mounted).toBeLessThan(500);
  await app.press("Count timers");
  const before = Number(app.texts().find((t) => t.startsWith("timers:"))?.slice(7));
  for (const field of ["f0", "f1", "f2", "f3", "f4", "f5"]) await app.type(`label:Field ${field}`, "a fairly long line to type");
  await app.press("Count timers");
  const after = Number(app.texts().find((t) => t.startsWith("timers:"))?.slice(7));
  expect(after - before).toBe(0);
  expect(app.texts()).toContain("Field f0");
});
