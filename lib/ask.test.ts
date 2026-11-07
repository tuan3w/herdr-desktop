import { expect, test } from "nsh/test";

import type { PermissionChoiceView, PromptOption, PromptView, SessionView, WaitingView } from "herdr-desktop/native";

import { fromPrompt, fromWaiting, replyTarget } from "#lib/ask";

const option = (index: number, label: string, over: Partial<PromptOption> = {}): PromptOption => ({
  label,
  standingGrant: false,
  reject: false,
  index,
  ...over,
});
const prompt = (options: PromptOption[], over: Partial<PromptView> = {}): PromptView => ({
  question: "Do you want to proceed?",
  options,
  digest: "d1",
  ...over,
});
const PANE = { machine: "local", pane: "w1:p1" };

const choice = (id: string, kind: string | undefined, standing = false): PermissionChoiceView => ({
  id,
  name: id,
  kind,
  standing,
});
const waiting = (choices: PermissionChoiceView[], over: Partial<WaitingView> = {}): WaitingView => ({
  requestId: "r1",
  digest: "d1",
  ask: "permission",
  arrivedMs: 0,
  title: "Bash",
  toolKind: "execute",
  subject: "git push origin main",
  choices,
  fields: [],
  ...over,
});
const session = (waitingNow: WaitingView[]) => ({
  machine: "local",
  id: "s1",
  view: { waiting: waitingNow, plan: [], itemCount: 0 } as unknown as SessionView,
});

test("a terminal prompt is risky and rejecting by what its options say, never by their place", () => {
  const ask = fromPrompt(
    prompt([
      option(0, "1. No", { reject: true }),
      option(1, "2. Yes, and always allow", { riskReason: "pushes to a remote", standingGrant: true }),
      option(2, "3. Yes"),
    ]),
    PANE,
  );
  expect(ask.options.map((o) => [o.risky, o.reject])).toEqual([
    [false, true],
    [true, false],
    [false, false],
  ]);
  expect(ask.options[1]!.reason).toBe("pushes to a remote");
});

test("a standing grant with no reason of its own is risky and says the permission outlives the answer", () => {
  const ask = fromPrompt(prompt([option(0, "1. Always", { standingGrant: true })]), PANE);
  expect(ask.options[0]).toMatchObject({ risky: true, reason: "grants standing permission" });
});

test("a terminal prompt has no risk line of its own: each risky option carries its reason, so it is read once", () => {
  const ask = fromPrompt(
    prompt([option(0, "1. Yes"), option(1, "2. Always", { riskReason: "deletes files", standingGrant: true })]),
    PANE,
  );
  expect(ask.risk).toBe(undefined);
  expect(ask.options.map((o) => o.reason)).toContain("deletes files");
  expect(ask.options[1]!.risky).toBe(true);
});

test("a permission's risk line is the agent's, and allowing is risky only while it is set", () => {
  const w = waiting([choice("allow", "allow_once"), choice("reject", "reject_once")], { risk: "pushes to a remote" });
  const ask = fromWaiting(w, session([w]));
  expect(ask.risk).toBe("pushes to a remote");
  expect(ask.options.map((o) => [o.risky, o.reject])).toEqual([
    [true, false],
    [false, true],
  ]);
  expect(ask.options[0]!.reason).toBe("pushes to a remote");

  const calm = waiting([choice("allow", "allow_once")]);
  expect(fromWaiting(calm, session([calm])).options[0]!.risky).toBe(false);
});

test("a standing choice says it is permanent, and rejecting forever is two presses too", () => {
  const w = waiting([choice("always", "allow_always", true), choice("never", "reject_always", true)], {
    risk: "pushes to a remote",
  });
  const [allow, reject] = fromWaiting(w, session([w])).options;
  expect(allow!.reason).toBe("pushes to a remote · grants this permanently");
  expect(reject).toMatchObject({ risky: true, reject: true, reason: "rejects this permanently" });
});

test("others still waiting are the session's other requests", () => {
  const first = waiting([choice("allow", "allow_once")]);
  const queue = [first, { ...first, requestId: "r2" }, { ...first, requestId: "r3" }];
  expect(fromWaiting(first, session(queue)).waitingElsewhere).toBe(2);
  expect(fromPrompt(prompt([option(0, "1. Yes")]), PANE, 3).waitingElsewhere).toBe(3);
});

test("a new question or request is a new identity, in another pane or session too", () => {
  const a = fromPrompt(prompt([option(0, "1. Yes")]), PANE).identity;
  expect(fromPrompt(prompt([option(0, "1. Yes")], { digest: "d2" }), PANE).identity).not.toBe(a);
  expect(fromPrompt(prompt([option(0, "1. Yes")]), { machine: "local", pane: "w1:p2" }).identity).not.toBe(a);
  const w = waiting([choice("allow", "allow_once")]);
  const b = fromWaiting(w, session([w])).identity;
  expect(fromWaiting({ ...w, digest: "d2" }, session([w])).identity).not.toBe(b);
  expect(fromWaiting(w, { ...session([w]), id: "s2" }).identity).not.toBe(b);
});

test("the reply field means deny: it needs a plain decline, and is absent without one", () => {
  const plain = fromPrompt(prompt([option(0, "1. Yes"), option(1, "2. No", { reject: true })]), PANE);
  expect(replyTarget(plain)?.label).toBe("2. No");
  expect(replyTarget(fromPrompt(prompt([option(0, "1. Yes"), option(1, "2. Always")]), PANE))).toBe(undefined);
  // A decline that is itself a two-press standing answer is not what a quiet reply should press.
  const forever = fromPrompt(
    prompt([option(0, "1. Yes"), option(1, "2. Never", { reject: true, standingGrant: true })]),
    PANE,
  );
  expect(replyTarget(forever)).toBe(undefined);
});

test("a permission's reply declines with its reject once, ahead of one that lasts", () => {
  const w = waiting([
    choice("allow", "allow_once"),
    choice("never", "reject_always", true),
    choice("no", "reject_once"),
  ]);
  expect(replyTarget(fromWaiting(w, session([w])))?.id).toBe("no");
});
