import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { chatReady } from "../app-seam";

/**
 * The chat tab. Two kinds of test, both through `session-lab.tsx`: a real keeper driving herdr-mobile's scripted ACP agent
 * (what the person types comes back as the agent's words), and a scripted port for the scenes that agent cannot make (a
 * plan, an edit, a subagent, a kind the app does not know, hundreds of rows).
 */
const DESKTOP = { width: 1280, height: 800, platform: "linux" as const };

/** The tab on a real keeper, once the session is open: while it says `Opening` the box refuses a send, and typing before that is lost. */
async function keeper(): Promise<App> {
  const app = await open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "keeper" } } });
  await chatReady(app);
  return app;
}
const scripted = (scene: string) =>
  open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "scripted", scene } } });
const model = () => open("./session-lab.tsx", { ...DESKTOP, host: { params: { mode: "model" } } });

const BOX = "label:Message";
/** Whether some text on screen holds `part`. */
const said = (app: App, part: string) => app.texts().some((t) => t.includes(part));
const label = (re: string) => `label:/${re}/`;

/** Presses `button` until `done` is true: a Stop that just appeared ignores presses for 400 ms. */
async function pressUntil(app: App, button: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(`pressing "${button}" never did it; on screen: ${JSON.stringify(app.texts())}`);
    await app.press(button).catch(() => undefined);
    await app.wait(25);
  }
}

async function say_(app: App, text: string): Promise<void> {
  await app.type(BOX, text);
  await app.submit(BOX);
}

test("a prompt streams the agent's words onto the page, its work folds into one line, and a folded line opens to its calls", async () => {
  const app = await keeper();
  await app.waitFor(BOX);

  await say_(app, "plain");
  await app.waitFor(label("^Agent: Hello"));
  expect(app.shows(label("^You: plain"))).toBe(true);
  expect(app.value(BOX)).toBe("");

  // A thought and two commands, then the answer: the work is one line, and the answer stays.
  await say_(app, "heavy:2:1:2:A");
  await app.waitFor(label("^Agent: answer A"));
  await app.waitFor(label("^Ran 2 commands"));
  expect(app.shows(label("^Tool: "))).toBe(false);

  await app.press(label("^Ran 2 commands"));
  await app.waitFor(label("^Tool: .*step 0"));
  expect(app.shows(label("^Tool: .*step 1"))).toBe(true);
  expect(app.shows(label("^Thought"))).toBe(true);

  await app.press(label("^Ran 2 commands"));
  await app.waitUntil(() => !app.shows(label("^Tool: ")));
});

test("Stop appears while a turn runs with nothing typed and ends the turn; what was typed meanwhile is queued and can be taken back", async () => {
  const app = await keeper();
  await app.waitFor(BOX);
  expect(app.shows("label:Stop")).toBe(false);

  await say_(app, "slow");
  await app.waitFor("label:Stop");
  expect(app.shows("text:Queue a message")).toBe(true);

  // Typed while the agent works: queued, shown above the box, and the button is Queue, not Stop.
  await say_(app, "after that, run the tests");
  await app.waitFor(label("^Queued: after that"));
  expect(app.value(BOX)).toBe("");

  // Taking it back puts the words in the box and removes the chip.
  await app.press(label("^Take back: after that"));
  await app.waitUntil(() => app.value(BOX) === "after that, run the tests");
  expect(app.shows(label("^Queued: "))).toBe(false);

  await app.clear(BOX);
  await pressUntil(app, "label:Stop", () => !app.shows("label:Stop"));
  expect(app.shows("label:Send message")).toBe(true);
});

test("a 5,000-row conversation opens at its end and builds only the rows near the window", async () => {
  const app = await keeper();
  await app.waitFor(BOX);
  await say_(app, "long:5000");
  await app.waitFor(label("^Agent: .*line 4999"), { timeout: 60_000 });

  // Only the rows near the window exist, not five thousand.
  expect(app.count(label("^Agent: "))).toBeLessThan(80);
  expect(app.shows(label("^You: long:5000"))).toBe(false);
});

test("the agent's answer is announced once when the turn ends, not word by word, and history is never news", async () => {
  const app = await model();
  await app.waitFor("Rows: 2");
  await app.press("Replay is over");
  await app.press("Person asks");
  await app.waitFor("Working: yes");
  await app.press("Agent starts");
  await app.waitUntil(() => said(app, "arrived 1"));
  await app.press("Agent streams");
  await app.waitUntil(() => said(app, "streamed  two"));
  expect(said(app, "answered")).toBe(false);
  await app.press("Turn ends");
  await app.waitUntil(() => said(app, "answered One two"));
  expect(app.texts().filter((t) => t.includes("answered One two"))).toHaveLength(1);
  expect(said(app, "answered history")).toBe(false);
  expect(said(app, "arrived 2")).toBe(false);
});

test("a finished turn reads like a chat: your message, the answer on the page as Markdown, the work folded, the summary line", async () => {
  const app = await scripted("chat");
  await app.waitFor(label("^You: Fix the login redirect"));
  expect(app.shows(label("^Agent: The loop came from"))).toBe(true);
  // How long it took is not said: a turn is ranked by what it did, and the agent's `done` item draws nothing.
  expect(said(app, "Done in 41s")).toBe(false);
  // The table and the list are the answer's own; the fence is code, not a sentence.
  expect(said(app, "unit tests")).toBe(true);
  // The fold is one line of counts, with no time: the thought is not counted, the read and the command are.
  expect(app.shows(label("^Read 1 file, ran 1 command$"))).toBe(true);
  expect(app.shows(label("^Tool: "))).toBe(false);

  await app.press(label("^Read 1 file, ran 1 command$"));
  await app.waitFor(label("^Tool: Read src/auth.ts, done"));
  expect(app.shows(label("^Tool: Ran grep callback in src, done"))).toBe(true);
  expect(app.shows(label("^Thought"))).toBe(true);
});

test("while the turn runs every group is one folded line and one live line says what it does now; when it ends, a failure stays in view", async () => {
  const app = await scripted("tools");
  await app.waitFor(label("^Running pnpm test promo-eu$"));
  // Nothing is open on its own: the calls are behind their lines, the subagent stands outside any fold.
  expect(app.shows(label("^Read 1 file, ran 1 command, edited 1 file$"))).toBe(true);
  expect(app.shows(label("^Tool: "))).toBe(false);
  expect(app.shows(label("^Subagent: tax-rules, done"))).toBe(true);
  expect(app.shows(label("^Failed: "))).toBe(false);

  await app.press("Finish the turn");
  await app.waitUntil(() => !app.shows(label("^Running pnpm test promo-eu$")));
  expect(app.shows(label("^Subagent: tax-rules"))).toBe(true);
  // The failed run is folded, and still said, with the last line it printed and no exit code of our own.
  await app.waitFor(label("^Failed: Ran pnpm test, Ran all test suites\\.$"));
  expect(app.shows(label("^Edited 1 file, 3 added, 1 removed. Open changes$"))).toBe(true);

  await app.press(label("^Read 1 file, ran 1 command, edited 1 file$"));
  await app.waitFor(label("^Tool: Ran pnpm test, failed"));
});

test("a running task call shows one line per subagent with the tool it is in; when all are done the lines fold into a summary", async () => {
  const app = await scripted("subagents");
  // omp's launcher (kind `other`) is the bordered card, and its lines are in view without opening it.
  await app.waitFor(label("^Subagent: Spawning 3 subagents, running$"));
  expect(app.shows(label("^Subagent audit, running, Reading src/auth\\.ts, 12 tools, 1m 4s$"))).toBe(true);
  expect(app.shows(label("^Subagent tests, running, Running pnpm test promo-eu, 4 tools, 31s$"))).toBe(true);
  // A finished one says the last thing it did, in the past tense.
  expect(app.shows(label("^Subagent review, done, Read src/auth\\.ts, 7 tools, 2m 10s$"))).toBe(true);
  expect(said(app, "3 subagents, ")).toBe(false);
  // Nothing shows as a plain call: the launcher stands outside the fold.
  expect(app.shows(label("^Tool: "))).toBe(false);

  await app.press("Subagents finish");
  await app.waitFor(label("^Subagent: Spawning 3 subagents, done, 3 subagents, 2m 10s$"));
  expect(said(app, "3 subagents, 2m 10s")).toBe(true);
  // Folded behind the chevron: the lines are gone until the card is opened.
  expect(app.shows(label("^Subagent audit"))).toBe(false);
  await app.press(label("^Subagent: Spawning 3 subagents"));
  await app.waitFor(label("^Subagent audit, done, Read src/auth\\.ts, 12 tools, 1m 4s$"));
  expect(app.shows(label("^Subagent tests, done, Ran pnpm test promo-eu, 4 tools, 31s$"))).toBe(true);
});

test("a finished turn is ranked by consequence: the narration and reads fold, the failure, the push and the edits stay", async () => {
  const app = await scripted("ranked");
  await app.waitFor(label("^Agent: Fixed in"));
  expect(app.shows(label("^Read 2 files, ran 3 commands, edited 1 file$"))).toBe(true);
  expect(app.shows(label("^Agent: Found it"))).toBe(false);
  expect(app.shows(label("^Failed: Ran pnpm test, 1 failed, 39 passed$"))).toBe(true);
  expect(app.shows(label("^Pushed to origin/main$"))).toBe(true);
  expect(app.shows(label("^Edited 1 file, 3 added, 1 removed. Open changes$"))).toBe(true);
  // Opening the fold shows the narration with the steps, and a failed step says how it ended.
  await app.press(label("^Read 2 files, ran 3 commands, edited 1 file$"));
  await app.waitFor(label("^Tool: Read src/auth.ts, done"));
  expect(said(app, "Found it. Changing")).toBe(true);
});

test("a call opens to what it did: the edit as a diff, the command whole, the output with Show all, the lines the machine did not keep", async () => {
  const app = await scripted("tools");
  await app.press(label("^Read 1 file, ran 1 command, edited 1 file$"));
  await app.waitFor(label("^Tool: Edited src/auth.ts"));
  await app.press(label("^Tool: Edited src/auth.ts"));
  await app.waitFor("label:/^Diff of src\\/auth\\.ts, 2 added, 1 removed$/");
  expect(app.shows("label:Open src/auth.ts")).toBe(true);

  await app.press(label("^Tool: Ran pnpm test, failed"));
  await app.waitFor("label:Copy code");
  expect(said(app, "pnpm test")).toBe(true);
  await app.waitFor("label:Show all 10 lines of output");
  expect(said(app, "lines not kept")).toBe(false);
  await app.press("label:Show all 10 lines of output");
  await app.waitUntil(() => said(app, "20 lines not kept"));
  expect(app.shows("label:Show all 10 lines of output")).toBe(false);
});

test("the plan is a checklist that updates in place, and the queue shows what waits and gives it back", async () => {
  const app = await scripted("plan");
  await app.waitFor(label("^Plan, 1 of 3 done, now Make login"));
  await app.press(label("^Plan, 1 of 3 done"));
  await app.waitFor("label:Make login honour the requested page, in progress");
  expect(app.shows("label:Reproduce the redirect loop, done")).toBe(true);
  expect(app.shows("label:Run the tests, to do")).toBe(true);

  await app.press("Advance plan");
  await app.waitFor(label("^Plan, 2 of 3 done, now Run the tests"));
  expect(app.shows("label:Run the tests, in progress")).toBe(true);

  expect(app.shows(label("^Queued: Also add a regression test"))).toBe(true);
  expect(app.shows(label("^Queued: Then update the changelog, 1 files"))).toBe(true);
  await app.press(label("^Take back: Also add a regression"));
  await app.waitUntil(() => app.value(BOX) === "Also add a regression test for the callback");
  expect(app.shows(label("^Queued: Also add"))).toBe(false);
  expect(app.shows(label("^Queued: Then update"))).toBe(true);
});

test("a slash lists the agent's own commands and picks one without sending it", async () => {
  const app = await scripted("plan");
  await app.waitFor(BOX);
  await app.type(BOX, "/rev");
  await app.waitFor("label:Commands");
  expect(app.shows(label("^/review"))).toBe(true);
  expect(app.shows(label("^/compact"))).toBe(false);

  await app.press(label("^/review"));
  await app.waitUntil(() => app.value(BOX) === "/review ");
  expect(said(app, "takes <branch>")).toBe(true);
  expect(app.shows("label:Commands")).toBe(false);
});

test("sending goes through the port with what was typed, an empty box sends nothing, and a send while the agent works is queued", async () => {
  const app = await scripted("chat");
  await app.waitFor(BOX);
  await app.submit(BOX);
  expect(said(app, "Log: nothing yet")).toBe(true);

  await say_(app, "run the tests");
  await app.waitFor(label("^You: run the tests"));
  await app.waitUntil(() => said(app, "send run the tests"));
  expect(app.value(BOX)).toBe("");

  // The scripted agent is now working: the next message waits for the turn, and the empty box says so.
  await app.waitFor("label:Stop");
  expect(app.shows("text:Queue a message")).toBe(true);
  await say_(app, "and the lint");
  await app.waitFor(label("^Queued: and the lint"));
  expect(said(app, "send and the lint")).toBe(true);

  await app.type(BOX, "draft");
  expect(app.shows("label:Queue message")).toBe(true);
});

test("Stop asks the port to stop the turn, and Stop is not there when nothing runs", async () => {
  const app = await scripted("tools");
  await app.waitFor("label:Stop");
  await pressUntil(app, "label:Stop", () => said(app, "cancel"));
  await app.waitUntil(() => !app.shows("label:Stop"));
  expect(app.shows("label:Send message")).toBe(true);
});

test("a message the box cannot take says why and is off: a lost connection offers Reconnect, and the words stay", async () => {
  const app = await scripted("chat");
  await app.waitFor(BOX);
  await app.type(BOX, "keep me");
  await app.press("Lose the connection");
  await app.waitFor("Reconnect");
  expect(said(app, "Not connected to")).toBe(true);
  expect(app.enabled(BOX)).toBe(false);

  await app.press("Reconnect");
  await app.waitUntil(() => said(app, "reconnect"));
  await app.waitUntil(() => app.enabled(BOX));
  expect(app.value(BOX)).toBe("keep me");
});

test("a kind of row nobody knows draws a quiet line and the chat goes on", async () => {
  const app = await scripted("chat");
  await app.waitFor(label("^You: Fix the login"));
  await app.press("Add unknown kind");
  await app.waitFor("Something new");
  expect(app.shows(label("^You: Fix the login"))).toBe(true);
});

test("away from the end the view holds still and a pill counts what is new; the pill brings you back, and the end is followed again", async () => {
  const app = await scripted("long");
  await app.waitFor(label("^Agent: Answer 200"));
  expect(app.shows("Jump to latest")).toBe(false);

  await app.scroll("label:Conversation", -4000);
  await app.waitFor("Jump to latest");
  expect(app.shows(label("^Agent: Answer 200"))).toBe(false);

  await app.press("Agent starts a message");
  await app.waitFor("1 new message");
  await app.press("1 new message");
  await app.waitUntil(() => !app.shows("1 new message"));
  await app.waitFor(label("^Agent: A new answer"));

  // At the end again: more text arrives and no pill appears.
  await app.press("Agent says more");
  await app.waitFor(label("^Agent: A new answer.*And more text"));
  expect(app.shows("Jump to latest")).toBe(false);
});

test("a chat put away and brought back is where it was left: scrolled away stays scrolled away, at the end stays at the end", async () => {
  const app = await scripted("long");
  await app.waitFor(label("^Agent: Answer 200"));
  // At the end: away and back, the end is shown and no pill.
  await app.press("Go away");
  await app.press("Come back");
  await app.waitFor(label("^Agent: Answer 200"));
  expect(app.shows("Jump to latest")).toBe(false);

  await app.scroll("label:Conversation", -4000);
  await app.waitFor("Jump to latest");
  await app.waitUntil(() => !app.shows(label("^Agent: Answer 200")));
  // The position is written when the scrolling goes quiet.
  await app.wait(800);
  await app.press("Go away");
  expect(app.shows("label:Conversation")).toBe(false);
  await app.press("Come back");
  await app.waitFor("label:Conversation");
  await app.waitFor("Jump to latest");
  await app.wait(2000);
  expect(app.shows(label("^Agent: Answer 200"))).toBe(false);
  expect(app.shows("Jump to latest")).toBe(true);
});

test("a request that waits is what the pill says when the person is away from the end", async () => {
  const app = await scripted("long");
  await app.waitFor(label("^Agent: Answer 200"));
  await app.scroll("label:Conversation", -4000);
  await app.waitFor("Jump to latest");
  await app.press("Request waits");
  await app.waitFor("label:Needs you");
  expect(app.shows("Jump to latest")).toBe(false);
});

test("the notice that earlier turns are no longer kept sits above the first row", async () => {
  const app = await scripted("earlier");
  await app.waitFor("Earlier messages are no longer kept");
  expect(app.texts().indexOf("Earlier messages are no longer kept")).toBeLessThan(
    app.texts().indexOf("Where were we?"),
  );
});

test("an ended session says so at the end of the conversation and in the box, and takes no message", async () => {
  const app = await scripted("ended");
  await app.waitFor("Session ended: the agent exited with code 3");
  expect(app.enabled(BOX)).toBe(false);
  expect(said(app, "Turn ended: the agent exited")).toBe(true);
});

/** Presses `key` until `done`: a page key pressed while the list is still measuring its rows lands on a stale size and may move nothing, so a person presses again. */
async function keyUntil(app: App, key: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(`pressing ${key} never did it; on screen: ${JSON.stringify(app.texts())}`);
    await app.keyboard.press(key);
    await app.wait(50);
  }
}

test("PageUp scrolls a page back from the message box and PageDown comes forward again, to the end", async () => {
  const app = await scripted("long");
  await app.waitFor(label("^Agent: Answer 200"));
  await app.type(BOX, "x");
  await keyUntil(app, "pageup", () => app.shows("Jump to latest"));
  await keyUntil(app, "pageup", () => !app.shows(label("^Agent: Answer 200")));
  await keyUntil(app, "pagedown", () => !app.shows("Jump to latest"));
  expect(app.shows(label("^Agent: Answer 200"))).toBe(true);
});

test("two page keys pressed faster than the list reports its scroll move two pages", async () => {
  const app = await scripted("long");
  await app.waitFor(label("^Agent: Answer 200"));
  await app.type(BOX, "x");
  await keyUntil(app, "pageup", () => app.shows("Jump to latest"));
  const onePage = app.texts().join("\n");
  await keyUntil(app, "pagedown", () => !app.shows("Jump to latest"));
  // A held key repeats faster than the list reports a scroll: the second press must not read the offset of before the
  // first. Two presses with nothing between them; the screen then has to leave where one page up put it, so the
  // wait is for that change and not for a time.
  await app.keyboard.press("pageup");
  await app.keyboard.press("pageup");
  await app.waitUntil(() => app.texts().join("\n") !== onePage);
});

const LOG = "Log: ";
const logged = (app: App, part: string) => app.texts().some((t) => t.startsWith(LOG) && t.includes(part));

test("an agent that refuses the session until a sign-in takes the place of the conversation and the box, with one button per way", async () => {
  const app = await scripted("signin");
  await app.waitFor("Claude Code needs you to sign in");
  // The agent's own names and what it says of each; nothing to type into, nothing signed in by itself.
  expect(app.shows("Use existing local credentials")).toBe(true);
  expect(app.shows("Sign in with an account")).toBe(true);
  expect(said(app, "Sign in with the login this machine already has.")).toBe(true);
  expect(app.shows(BOX)).toBe(false);
  expect(logged(app, "authenticate")).toBe(false);

  // A way done in a terminal gives the exact arguments, quoted for a shell, and never opens anything.
  expect(said(app, "--login --provider 'my cloud'")).toBe(true);
  await app.press("label:/^Copy command/");
  await app.waitUntil(() => app.clipboard() === "--login --provider 'my cloud'");
});

test("signing in with a way the app carries out opens the session: the box is back and the card is gone", async () => {
  const app = await scripted("signin");
  await app.waitFor("Claude Code needs you to sign in");
  await app.press("Use existing local credentials");
  await app.waitFor(BOX);
  expect(logged(app, "authenticate login")).toBe(true);
  expect(app.shows("Claude Code needs you to sign in")).toBe(false);
});

test("while the agent decides the button is busy and the others wait; a refusal is the agent's message under the buttons, which stay", async () => {
  const app = await scripted("signin");
  await app.waitFor("Claude Code needs you to sign in");
  await app.press("Sign in with an account");
  await app.waitFor("label:Sign in with an account, busy");
  expect(app.enabled("Use existing local credentials")).toBe(false);

  await app.press("Agent answers");
  await app.waitFor("The agent refused: this account has no seat.");
  expect(app.shows("Sign in with an account")).toBe(true);
  expect(app.enabled("Use existing local credentials")).toBe(true);
  expect(app.shows(BOX)).toBe(false);
});

test("after a sign-in in a terminal, trying again says it still asks until it does not", async () => {
  const app = await scripted("signin");
  await app.waitFor("Claude Code needs you to sign in");
  await app.press("I did it, try again");
  await app.waitFor("The agent still asks you to sign in.");
  expect(logged(app, "reopen")).toBe(true);
  expect(app.shows("Use existing local credentials")).toBe(true);

  await app.press("I signed in elsewhere");
  await app.press("I did it, try again");
  await app.waitFor(BOX);
  expect(app.shows("The agent still asks you to sign in.")).toBe(false);
});

test("a finished agent message copies as plain text, or as the Markdown it was written in", async () => {
  const app = await scripted("chat");
  await app.waitFor(label("^Agent: The loop came"));
  await app.press("label:Copy message");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("The loop came from login"));
  // The whole answer, the code block and the table included, without the marks that draw them.
  expect(app.clipboard()).toContain("unit tests\t42 passed");
  expect(app.clipboard()).toContain("export function login(user: User)");
  expect(app.clipboard()).not.toContain("`");
  await app.press("label:Message options");
  await app.press("label:Copy as Markdown");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("The loop came from `login`"));
  expect(app.clipboard()).toContain("| unit tests | 42 passed |");
});

// ---- code in the chat ----

/** The TypeScript fence of the `code` scene, as written: what `Copy code` must put on the clipboard. */
const TS_FENCE = [
  "export async function send(req: Request, attempts = 3): Promise<Response> {",
  "  for (let i = 0; i < attempts; i++) {",
  "    const res = await fetch(req.url, { method: req.method, signal: AbortSignal.timeout(2_500) });",
  "    if (res.ok || res.status < 500) return res;",
  "    await sleep(2 ** i * 100); // back off",
  "  }",
  "  throw new Error(`gave up after ${attempts} tries`);",
  "}",
].join("\n");

test("a fence in an answer is a code block named by its language, and Copy code puts exactly its text on the clipboard", async () => {
  const app = await scripted("code");
  await app.waitFor("label:/^Code, TypeScript, 8 lines$/");
  expect(app.shows("label:/^Code, Rust, 10 lines$/")).toBe(true);
  expect(app.shows("label:/^Code, Python, 7 lines$/")).toBe(true);
  expect(app.shows("label:/^Code, Shell, 1 line$/")).toBe(true);
  // The prose around the blocks is still prose, and the code is text a screen reader can read line by line.
  expect(said(app, "The retry loop lives in")).toBe(true);
  expect(said(app, "throw new Error")).toBe(true);

  await app.press("label:Copy code >> nth=0");
  await app.waitUntil(() => app.clipboard() === TS_FENCE);
});

test("a fence with no language is read from its text, and a language nobody has a grammar for is drawn plain", async () => {
  const app = await scripted("code");
  // Five lines of JSON with no word after the fence: found by their shape.
  await app.waitFor("label:/^Code, JSON, 5 lines$/");
  // A made-up word is plain text: no language in its name, and its words are all there.
  expect(app.shows("label:/^Code, 2 lines$/")).toBe(true);
  expect(said(app, "wibble the wobble")).toBe(true);
});

test("a long block folds to its first lines in the chat, and a fence inside a list item is a block too", async () => {
  const app = await scripted("code");
  await app.waitFor("label:/^Show all 302 lines$/");
  expect(said(app, "ledger.record(299")).toBe(false);
  expect(app.shows("label:/^Code, Shell, 1 line$/")).toBe(true);
  expect(said(app, "echo inside a list")).toBe(true);
  // Opening the fold is a choice the chat keeps: it is not undone when the message is drawn again.
  await app.press("label:/^Show all 302 lines$/");
  await app.waitFor("Show fewer lines");
});

test("Copy code takes the last block of the last answer, and Copy answer the whole answer as it was written", async () => {
  const app = await scripted("code");
  await app.waitFor("label:/^Code, TypeScript, 8 lines$/");
  await app.keyboard.press("mod+shift+c");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("fn replay(ledger: &mut Ledger) {"));
  expect((app.clipboard() ?? "").split("\n")).toHaveLength(302);
  expect(app.clipboard()).not.toContain("```");

  await app.keyboard.press("mod+shift+y");
  await app.waitUntil(() => (app.clipboard() ?? "").startsWith("The retry loop lives in"));
  expect(app.clipboard()).toContain("```ts\n" + TS_FENCE + "\n```");
});

test("an answer that is still being written shows its open fence as it stands, and ends in the same state as the answer whole", async () => {
  const live = await open("./session-lab.tsx", {
    ...DESKTOP,
    host: { params: { mode: "scripted", scene: "code-stream" } },
  });
  await live.waitFor("Stream a piece");
  // The prose, the fence's opening line and two lines of code.
  for (let i = 0; i < 4; i++) await live.press("Stream a piece");
  await live.waitFor("label:/^Code, TypeScript, 2 lines$/");
  expect(said(live, "for (let i = 0; i < 3; i++)")).toBe(true);
  // A block that is being written never folds.
  expect(live.shows("label:/^Show all/")).toBe(false);
  for (let i = 0; i < 7; i++) await live.press("Stream a piece");
  await live.press("Finish the turn");
  await live.waitFor("label:/^Code, TypeScript, 7 lines$/");

  const whole = await open("./session-lab.tsx", {
    ...DESKTOP,
    host: { params: { mode: "scripted", scene: "code-stream", instant: true } },
  });
  await whole.press("Finish the turn");
  await whole.waitFor("label:/^Code, TypeScript, 7 lines$/");
  await live.keyboard.press("mod+shift+c");
  await whole.keyboard.press("mod+shift+c");
  await live.waitUntil(() => (live.clipboard() ?? "") !== "");
  await whole.waitUntil(() => (whole.clipboard() ?? "") !== "");
  expect(live.clipboard()).toBe(whole.clipboard());
  // Everything on screen but the two windows' own scratch folders.
  const shown = (a: App) => a.texts().filter((t) => !t.includes("/herdr-desktop-"));
  expect(shown(live)).toEqual(shown(whole));
});

test("a long fence being written does not take the end away: the chat keeps following it and never offers a jump", async () => {
  const app = await open("./session-lab.tsx", {
    ...DESKTOP,
    host: { params: { mode: "scripted", scene: "code-stream", lines: 600 } },
  });
  await app.waitFor("Stream a piece");
  // The prose, the fence's opening line, then 600 lines in pieces of 20.
  for (let i = 0; i < 2 + 30; i++) {
    await app.press("Stream a piece");
    await app.wait(40);
  }
  await app.waitUntil(() => said(app, "let value_599"));
  // The block is far taller than the window; the end of it is on screen and the transcript is still at its end.
  expect(said(app, "let value_0 ")).toBe(false);
  expect(app.shows("Jump to latest")).toBe(false);
  expect(app.shows("label:/^New messages/")).toBe(false);
  expect(app.shows("label:/^Show all/")).toBe(false);
});
