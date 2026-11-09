import { expect, open, test } from "nsh/test";

test("a dialog stays up while what keeps it open changes: its content is not built again (Settings' page switch flickered)", async () => {
  const a = await open("./modal-probe.tsx", { width: 1280, height: 800, platform: "linux", clock: {} });
  await a.press("Open");
  await a.waitFor("text:showing first");
  expect(a.shows("text:built 1")).toBe(true);
  await a.press("Second page");
  await a.waitFor("text:showing second");
  await a.press("First page");
  await a.waitFor("text:showing first");
  expect(a.shows("text:built 1")).toBe(true);
});
