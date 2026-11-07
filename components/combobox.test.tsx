import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1280, height: 800 };
const lab = () => open("./combobox-probe.tsx", DESKTOP);

const AGENT = "label:Agent";
const MULTI = "label:Multiple agents";
const HUGE = "label:Session (50,000)";
const BIG = "label:Session";

test("typing narrows the list, accents ignored; Enter picks the first match and the field shows its title", async () => {
  const app = await lab();
  await app.type(AGENT, "creme");
  expect(app.shows("label:Crème Agent")).toBe(true);
  expect(app.shows("label:Claude")).toBe(false);
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("agent:creme");
  expect(app.value(AGENT)).toBe("Crème Agent");
  expect(app.shows("label:OMP")).toBe(false);
});

test("Down opens the list on the first row, Up and Down wrap, and a disabled row is skipped", async () => {
  const app = await lab();
  await app.type(AGENT, "");
  expect(app.shows("label:OMP")).toBe(false);
  await app.keyboard.press("down");
  expect(app.shows("label:OMP")).toBe(true);
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  // Claude, OMP, Codex, then Aider is disabled: the next row is Gemini CLI
  expect(app.texts().join("|")).toContain("hl:gemini:keyboard");
  await app.keyboard.press("up");
  expect(app.texts().join("|")).toContain("hl:codex:keyboard");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("agent:codex");
});

test("Escape closes the list and puts the chosen title back", async () => {
  const app = await lab();
  await app.type(AGENT, "omp");
  await app.keyboard.press("enter");
  expect(app.value(AGENT)).toBe("OMP");
  await app.type(AGENT, "zzz");
  expect(app.value(AGENT)).toBe("OMPzzz");
  await app.keyboard.press("escape");
  expect(app.value(AGENT)).toBe("OMP");
  expect(app.shows("label:Codex")).toBe(false);
});

test("a search with no match says so, and the empty state is a row of the list, not a blank", async () => {
  const app = await lab();
  await app.type(AGENT, "zzzz");
  expect(app.texts()).toContain("No results");
  await app.clear(AGENT);
  await app.type(AGENT, "google");
  // keywords are searched without being shown
  expect(app.shows("label:Gemini CLI")).toBe(true);
});

test("groups show a heading, and a pointer press picks", async () => {
  const app = await lab();
  await app.press("label:Open Agent list");
  expect(app.texts()).toContain("Local");
  expect(app.texts()).toContain("Cloud");
  await app.press("label:Cursor Agent");
  expect(app.texts()).toContain("agent:cursor");
  expect(app.shows("label:OMP")).toBe(false);
});

test("the clear button empties a single choice", async () => {
  const app = await lab();
  await app.type(AGENT, "codex");
  await app.keyboard.press("enter");
  await app.press("label:Clear selection: Agent");
  expect(app.texts()).toContain("agent:");
  expect(app.shows("label:Clear selection: Agent")).toBe(false);
});

test("a multiple choice shows chips; a pick adds one, a chip's cross removes it, Backspace in the empty field removes the last", async () => {
  const app = await lab();
  expect(app.shows("label:Remove Claude")).toBe(true);
  await app.type(MULTI, "codex");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("agents:claude,codex");
  expect(app.shows("label:Remove Codex")).toBe(true);
  await app.type(MULTI, "");
  await app.keyboard.press("backspace");
  expect(app.texts()).toContain("agents:claude");
  await app.press("label:Remove Claude");
  expect(app.texts()).toContain("agents:");
});

test("picking a chosen row again takes it out, and the clear button removes every chip", async () => {
  const app = await lab();
  await app.press("label:Open Multiple agents list");
  await app.press("label:Claude, selected");
  expect(app.texts()).toContain("agents:");
  await app.type(MULTI, "omp");
  await app.keyboard.press("enter");
  await app.type(MULTI, "codex");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("agents:omp,codex");
  await app.press("label:Clear selection: Multiple agents");
  expect(app.texts()).toContain("agents:");
});

test("a read-only field opens and browses but changes nothing; a disabled one does nothing", async () => {
  const app = await lab();
  await app.press("label:Open Read only list");
  await app.press("label:OMP");
  expect(app.texts().join("|")).not.toContain("readonly-change");
  expect(app.enabled("label:Locked")).toBe(false);
});

test("5,000 options: the list builds a handful of rows, typing finds one by a part of its ref, and a pick lands", async () => {
  const app = await lab();
  await app.press("label:Open Session list");
  expect(app.count("label:/^SES-/")).toBeLessThan(30);
  await app.type(BIG, "00042");
  expect(app.shows("label:/^SES-07-00042, /")).toBe(true);
  expect(app.count("label:/^SES-/")).toBeLessThan(5);
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("session:s42");
});

test("50,000 options behave the same, and the count is told", async () => {
  const app = await lab();
  await app.press("label:Open Session (50,000) list");
  expect(app.count("label:/^SES-/")).toBeLessThan(30);
  await app.type(HUGE, "49999");
  await app.waitFor("label:/^SES-08-49999, /");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("huge:s49999");
});

test("items that arrive late: the list says it is loading, then shows what came", async () => {
  const app = await lab();
  await app.type("label:Search on server", "00042");
  expect(app.texts()).toContain("Loading…");
  expect(app.shows("label:/^SES-07-00042, /")).toBe(false);
  await app.wait(2100);
  await app.waitFor("label:/^SES-07-00042, /");
  await app.press("label:/^SES-07-00042, /");
  expect(app.texts()).toContain("async:s42");
});

test("an Autocomplete keeps what is typed: Enter with nothing highlighted does not pick, Down and Enter do", async () => {
  const app = await lab();
  await app.type("label:Machine", "lap");
  expect(app.shows("label:laptop (lt-01)")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.texts()).toContain("machine:lap");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain("machine:laptop (lt-01)");
  expect(app.texts().join("|")).toContain("pick:laptop (lt-01)");
});

test("Autocomplete modes: `both` writes the highlighted row into the field, `inline` also shows every row", async () => {
  const app = await lab();
  await app.type("label:Machine (both)", "wor");
  await app.keyboard.press("down");
  expect(app.value("label:Machine (both)")).toBe("workstation (ws-04)");
  // the typed text is what the owner still holds
  expect(app.texts()).toContain("mode:wor");
  await app.keyboard.press("escape");
  expect(app.value("label:Machine (both)")).toBe("wor");
  await app.type("label:Machine (inline)", "zzz");
  expect(app.shows("label:ci-runner (ci-07)")).toBe(true);
});

test("an Autocomplete with an `empty` text says so; one without shows no list", async () => {
  const app = await lab();
  await app.type("label:Machine (empty)", "zzzz");
  expect(app.texts()).toContain("No machines");
  await app.clear("label:Machine (empty)");
  await app.type("label:Machine", "zzzz");
  expect(app.shows("label:ci-runner (ci-07)")).toBe(false);
});

test("in a dialog the list is the dialog's own, and Escape closes the list before the dialog", async () => {
  const app = await lab();
  await app.press("Open dialog");
  await app.press("label:Open Agent in dialog list");
  expect(app.shows("label:/^Codex/")).toBe(true);
  await app.press("label:Codex");
  expect(app.texts()).toContain("dialog:codex");
  await app.press("label:Open Agent in dialog list");
  await app.keyboard.press("escape");
  expect(app.shows("text:Dialog")).toBe(true);
});
