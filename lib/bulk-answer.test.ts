import { expect, test } from "nsh/test";

import type { PromptOption, PromptView } from "herdr-desktop/native";

import { row } from "#lib/board-rows.fixture";
import {
  allowLabel,
  allowOnce,
  answerEntries,
  ARM_MS,
  CAP,
  declineOption,
  hasAnswerView,
  pressAllow,
  reconcile,
  resultText,
  stillArmed,
  tickBlock,
} from "#lib/bulk-answer";
import type { Entry, Ticks } from "#lib/bulk-answer";

const opt = (index: number, label: string, over: Partial<PromptOption> = {}): PromptOption => ({
  label,
  standingGrant: false,
  reject: false,
  index,
  ...over,
});
const prompt = (digest: string, options: PromptOption[], subject = "touch x"): PromptView => ({
  question: "Do you want to proceed?",
  subject,
  options,
  digest,
});
/** The menu of the fixtures: Yes, Yes and always, Yes and auto mode, No. */
const MENU = [
  opt(0, "1. Yes"),
  opt(1, "2. Yes, and always allow", { standingGrant: true }),
  opt(2, "3. Yes, and switch to auto mode"),
  opt(3, "4. No", { reject: true }),
];
const blocked = (pane: string, p?: PromptView, over = {}) =>
  row(`local/${pane}`, { status: "blocked", name: pane, prompt: p, ...over });
const entry = (pane: string, digest = "d1", options = MENU): Entry =>
  answerEntries([blocked(pane, prompt(digest, options))]).entries[0]!;

test("allow-once is found by meaning, whatever order the menu comes in", () => {
  // The decline first, the standing grant second, the plain allow last: index 0 or 1 would be wrong.
  const odd = prompt("a", [
    opt(0, "No", { reject: true }),
    opt(1, "Always", { standingGrant: true }),
    opt(2, "Run it once"),
  ]);
  expect(allowOnce(odd)?.index).toBe(2);
  expect(declineOption(odd)?.index).toBe(0);
  const reversed = prompt("b", [...MENU].reverse());
  expect(allowOnce(reversed)?.label).toBe("3. Yes, and switch to auto mode");
  expect(declineOption(reversed)?.label).toBe("4. No");
});

test("a risky option is never the allow, and a menu with no plain allow is not eligible", () => {
  const risky = prompt("r", [
    opt(0, "Yes", { riskReason: "pushes to a remote" }),
    opt(1, "Yes, always", { standingGrant: true }),
    opt(2, "No", { reject: true }),
  ]);
  expect(allowOnce(risky)).toBeUndefined();
  const e = answerEntries([blocked("p1", risky)]).entries[0]!;
  expect(e.allow).toBeUndefined();
  expect(e.why).toBe("risky");
  expect(e.say).toBe("Answer in its own tab");
  // Only a decline: nothing to allow.
  expect(allowOnce(prompt("n", [opt(0, "No", { reject: true })]))).toBeUndefined();
});

test("a question with no command to read is not bulk-answerable", () => {
  const e = answerEntries([blocked("p1", { ...prompt("a", MENU), subject: undefined })]).entries[0]!;
  expect(e.allow).toBeUndefined();
  expect(e.say).toBe("Answer in its own tab");
});

test("a decline that carries a risk is not a bulk decline", () => {
  const p = prompt("x", [opt(0, "Yes"), opt(1, "No, and never ask", { reject: true, standingGrant: true })]);
  expect(declineOption(p)).toBeUndefined();
});

test("the view lists blocked terminal agents, points chats to their chat, and skips the rest", () => {
  const rows = [
    blocked("p1", prompt("a", MENU)),
    blocked("p2", undefined, { session: true }),
    blocked("p3", undefined),
    row("local/p4", { status: "working", prompt: prompt("w", MENU) }),
    blocked("p5", prompt("o", MENU), { offline: true }),
  ];
  const { entries } = answerEntries(rows);
  // The terminal whose question is not read is listed too (never tickable); the chat comes last.
  expect(entries.map((e) => e.row.paneId)).toEqual(["p1", "p3", "p2"]);
  expect(entries[1]!.allow).toBeUndefined();
  expect(entries[2]!.say).toBe("Answer in the chat");
  expect(entries[2]!.allow).toBeUndefined();
  expect(hasAnswerView(rows)).toBe(true);
  // A chat alone does not open it.
  expect(hasAnswerView([rows[1]!])).toBe(false);
});

test("the view lists at most the cap and says how many more", () => {
  const rows = Array.from({ length: CAP + 5 }, (_, i) => blocked(`p${i}`, prompt(`d${i}`, MENU)));
  const { entries, more } = answerEntries(rows);
  expect(entries).toHaveLength(CAP);
  expect(more).toBe(5);
});

test("a tick is refused by a row that is not eligible, one inside its guard, and a tall command not yet read", () => {
  const ok = entry("p1");
  const calm = { guarded: false, overflow: false, read: false };
  expect(tickBlock(ok, calm)).toBeUndefined();
  expect(tickBlock(ok, { ...calm, guarded: true })).toBe("guard");
  expect(tickBlock(ok, { ...calm, overflow: true })).toBe("unread");
  expect(tickBlock(ok, { ...calm, overflow: true, read: true })).toBeUndefined();
  const chat = answerEntries([blocked("p2", undefined, { session: true })]).entries[0]!;
  expect(tickBlock(chat, calm)).toBe("ineligible");
});

const tick = (e: Entry) => ({
  [e.row.key]: { prompt: e.prompt!, allow: e.allow!, machine: e.row.machine, pane: e.row.paneId, name: e.row.name },
});

test("a tick for an agent that left, or whose question changed, does not stand", () => {
  const a = entry("p1");
  const b = entry("p2");
  const ticks: Ticks = { ...tick(a), ...tick(b) };
  // p1 stopped needing the person; p2 asks something else.
  const { kept, changed } = reconcile(ticks, [entry("p2", "d2")]);
  expect(Object.keys(kept)).toEqual([]);
  expect(changed).toEqual(["local/p2"]);
  // Nothing changed: both stand.
  expect(Object.keys(reconcile(ticks, [a, b]).kept)).toEqual(["local/p1", "local/p2"]);
});

test("the first press arms and sends nothing, the second sends, and four seconds disarm it", () => {
  const entries = [entry("p1"), entry("p2")];
  const ticks = tick(entries[0]!);
  expect(pressAllow(undefined, {}, entries, 0).action).toBe("none");
  const first = pressAllow(undefined, ticks, entries, 1000);
  expect(first.action).toBe("arm");
  expect(pressAllow(first.armed, ticks, entries, 1000 + ARM_MS - 1).action).toBe("send");
  // Late: it arms again instead of sending.
  expect(pressAllow(first.armed, ticks, entries, 1000 + ARM_MS).action).toBe("arm");
  expect(stillArmed(first.armed, ticks, entries, 1000 + ARM_MS)).toBe(false);
});

test("arming disarms when the ticked set changes, when a ticked question changes, and on a new question anywhere", () => {
  const entries = [entry("p1"), entry("p2"), entry("p3")];
  const ticks = tick(entries[0]!);
  const armed = pressAllow(undefined, ticks, entries, 0).armed;
  expect(stillArmed(armed, ticks, entries, 10)).toBe(true);
  // Another box ticked.
  expect(stillArmed(armed, { ...ticks, ...tick(entries[1]!) }, entries, 10)).toBe(false);
  // The ticked box unticked.
  expect(stillArmed(armed, {}, entries, 10)).toBe(false);
  // The ticked row asks something else (the tick as displayed is gone from the world).
  expect(stillArmed(armed, ticks, [entry("p1", "d9"), entries[1]!, entries[2]!], 10)).toBe(false);
  // A question changes on a row that is not ticked.
  expect(stillArmed(armed, ticks, [entries[0]!, entry("p2", "d9"), entries[2]!], 10)).toBe(false);
  // A new agent starts asking.
  expect(stillArmed(armed, ticks, [...entries, entry("p4")], 10)).toBe(false);
  // Pressing in any of those states arms again instead of sending.
  expect(pressAllow(armed, { ...ticks, ...tick(entries[1]!) }, entries, 10).action).toBe("arm");
});

test("the displayed row is what is ticked: the tick keeps the question and the option as shown", () => {
  const e = entry("p1", "shown");
  const t = tick(e)["local/p1"]!;
  expect(t.prompt.digest).toBe("shown");
  expect(t.allow.label).toBe("1. Yes");
  // The row asks something else later: the tick still names the old digest, so it is dropped rather than re-aimed.
  expect(reconcile(tick(e), [entry("p1", "later")]).changed).toEqual(["local/p1"]);
});

test("the button names its count, and armed says what the second press does", () => {
  expect(allowLabel(3, false)).toBe("Allow 3 commands");
  expect(allowLabel(1, false)).toBe("Allow 1 command");
  expect(allowLabel(3, true)).toBe("Press again to allow 3 · you read each command above");
});

test("the result names every agent and what was sent, and each refusal by name", () => {
  expect(
    resultText("Allowed", [
      { name: "payments review", kind: "sent", note: "" },
      { name: "auth", kind: "sent", note: "" },
      { name: "notes", kind: "changed", note: "" },
      { name: "web", kind: "stopped", note: "Not sent: offline" },
    ]),
  ).toBe("Allowed 2: payments review, auth · 2 not sent: notes (the question changed), web (Not sent: offline)");
  expect(resultText("Declined", [{ name: "a", kind: "sent", note: "" }])).toBe("Declined 1: a");
});
