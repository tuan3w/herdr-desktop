import { expect, open, test } from "nsh/test";

const lab = () => open("./sidebar-footer-lab.tsx", { width: 800, height: 600, platform: "linux" });

test("with every machine online the footer draws nothing", async () => {
  const app = await lab();
  expect(app.shows("label:Machines")).toBe(false);
  expect(app.count("label:/^(This computer|devbox), /")).toBe(0);
});

test("a stale or stuck machine is one line with what happened, a Fix button only when it needs the person, and nothing for a switched-off one", async () => {
  const app = await lab();
  await app.press("Show a stale and a stuck machine");
  expect(app.shows("label:Build box, Not connected: ssh: connection refused · reconnecting in 4 s")).toBe(true);
  expect(app.shows("label:/^GPU rig, Needs attention: run ssh gpu once/")).toBe(true);
  expect(app.shows("Old laptop")).toBe(false);
  expect(app.shows("label:Fix Build box")).toBe(false);
  await app.press("label:Fix GPU rig");
  expect(app.shows("machines dialog open")).toBe(true);
});

test("past three broken machines the rest fold into one line that opens them", async () => {
  const app = await lab();
  await app.press("Show six down");
  expect(app.count("label:/^Box \\d, Not connected/")).toBe(3);
  expect(app.shows("and 3 more machines")).toBe(true);
  await app.press("label:Show 3 more machines that are not connected");
  expect(app.count("label:/^Box \\d, Not connected/")).toBe(6);
  expect(app.shows("and 3 more machines")).toBe(false);
});
