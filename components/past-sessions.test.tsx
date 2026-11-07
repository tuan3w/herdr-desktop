import { expect, open, test } from "nsh/test";

/**
 * `Past sessions` against a real keeper and the scripted ACP agent. That agent keeps no store of its own here, so the
 * list itself is empty; what a person needs from this dialog when an agent has nothing to show is tested.
 */
const DESKTOP = { width: 1280, height: 900 };
const past = (params: Record<string, unknown> = {}) =>
  open("./chat-parts-lab.tsx", { ...DESKTOP, host: { params: { part: "past", ...params } } });

test("an agent that keeps no list says so, instead of showing an empty list that looks like nothing happened yet", async () => {
  const app = await past({ agent: "omp" });
  await app.waitFor("This agent cannot list its past sessions");
  expect(app.texts().some((t) => t.startsWith("Conversations omp kept on"))).toBe(true);
  expect(app.shows("Continue")).toBe(false);
});

test("without a given agent, the machine's own is chosen and its answer shows", async () => {
  const app = await past();
  await app.waitFor("This agent cannot list its past sessions");
  expect(app.shows("label:Agent: omp")).toBe(true);
});

test("a failure keeps its reason and offers another try", async () => {
  const app = await past({ agent: "nonesuch" });
  await app.waitFor("Try again");
  expect(app.texts().some((t) => t.includes("Unknown agent"))).toBe(true);
});

test("Close leaves the dialog and nothing is continued", async () => {
  const app = await past({ agent: "omp" });
  await app.waitFor("This agent cannot list its past sessions");
  await app.press("Close");
  expect(app.shows("Past sessions")).toBe(false);
  expect(app.shows("Opened local/")).toBe(false);
});
