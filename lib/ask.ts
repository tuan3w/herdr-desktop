import { Herdr, Sessions } from "herdr-desktop/native";

import type {
  ActionResult,
  PermissionChoiceView,
  PromptOption,
  PromptView,
  SessionView,
  WaitingView,
} from "herdr-desktop/native";

/**
 * What the one answer dock shows and does, whatever asked: a terminal agent's menu (`PromptView`, answered through its
 * pane) or an ACP session's permission request (`WaitingView`, answered through its keeper). The dock knows only this;
 * the two adapters below are where the sources differ. Everything the dock treats as a rule (risky, rejecting) is read
 * from the data here, never from an option's place in the list.
 */
export interface AskOption {
  /** Names the option to `send`. */
  id: string;
  /** The agent's own words. */
  label: string;
  /** Answering takes a second press. */
  risky: boolean;
  /** Why, in words; never empty for a risky option. */
  reason: string;
  /** The option declines. The reply field is built on it, and an allow is read to the end before it is pressed. */
  reject: boolean;
}

/** How an answer ended: `sent`; `changed` (the question is not what was shown: nothing was sent); `stopped` (nothing was sent, `note` says why). */
export interface AskOutcome {
  kind: "sent" | "changed" | "stopped";
  note: string;
}

export interface Ask {
  /** Changes with the question and with where it was asked: nothing armed or read carries over to a new one. */
  identity: string;
  /** The dock's accessible name. */
  label: string;
  /** What a refusal calls it (`The question changed`, `The request changed`). */
  noun: "question" | "request";
  /** The question, or what the agent asks to do. */
  heading: string;
  /** The agent's own title for the call, when it adds to the subject. */
  detail?: string;
  /** The command, URL or path being approved, whole. */
  subject?: string;
  /** `bash` when the subject is a command. */
  language?: "bash";
  /** Why the command deserves a second look, or nothing. Only a source whose risk is not one option's own sets it: a terminal menu's reasons live on its rows, where the person sees each once. */
  risk?: string;
  options: AskOption[];
  /** Other agents' (or this session's other) questions still waiting. */
  waitingElsewhere: number;
  /** The checked path: reads again, sends only if what was shown is still there. */
  send(option: AskOption): Promise<AskOutcome>;
  /** Types words after a decline went through (`replyTarget`). Never called before that answer reports `sent`. */
  say(text: string): Promise<AskOutcome>;
  /** Withdraws the request instead of answering it (a session's permission). */
  cancel?: () => Promise<AskOutcome>;
  /** The session whose request it is, for what the agent said and meant to edit before asking. */
  session?: { machine: string; id: string; view: SessionView };
}

const stopped = (note: string): AskOutcome => ({ kind: "stopped", note });
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How many times, and how far apart, `say` looks for the menu to be gone from the pane before it gives up (3 s). */
const LOOKS = 30;
const LOOK_MS = 100;

/** Resolves true once `pane` no longer shows the question with `digest`, false if it still does after `LOOKS` looks. */
function questionGone(machine: string, pane: string, digest: string): Promise<boolean> {
  return new Promise((resolve) => {
    let looked = 0;
    const look = () => {
      const now = Herdr.paneMeta(machine, pane)?.prompt;
      if (!now || now.digest !== digest) resolve(true);
      else if (++looked >= LOOKS) resolve(false);
      else setTimeout(look, LOOK_MS);
    };
    look();
  });
}

const isRisky = (o: PromptOption) => !!o.riskReason || o.standingGrant;

/** A terminal agent's menu, in `pane`. `others`: how many other agents wait, for the dock's `Next`. */
export function fromPrompt(prompt: PromptView, pane: { machine: string; pane: string }, others = 0): Ask {
  const options: AskOption[] = prompt.options.map((o) => ({
    id: String(o.index),
    label: o.label,
    risky: isRisky(o),
    reason: o.riskReason ?? "grants standing permission",
    reject: o.reject,
  }));
  return {
    identity: `${pane.machine}/${pane.pane}/${prompt.digest}`,
    label: "Answer",
    noun: "question",
    heading: prompt.question,
    subject: prompt.subject ?? undefined,
    options,
    waitingElsewhere: others,
    async send(option) {
      const result = await Herdr.answer(pane.machine, pane.pane, prompt.digest, Number(option.id)).catch(
        (e: unknown) => ({
          kind: "failed" as const,
          message: failure(e),
        }),
      );
      switch (result.kind) {
        case "sent":
          return { kind: "sent", note: `Sent: ${option.label}` };
        case "changed":
          return { kind: "changed", note: "" };
        case "notBlocked":
          return stopped("Not waiting for an answer any more. Nothing was sent.");
        default:
          return stopped(`Not sent: ${result.message ?? "the answer could not be delivered"}`);
      }
    },
    async say(text) {
      // The answer reported `sent` but the menu may be on screen for a moment more: words typed then would go into it.
      if (!(await questionGone(pane.machine, pane.pane, prompt.digest)))
        return stopped("Declined, but the question is still on the screen, so your words were not sent.");
      try {
        await Herdr.sendInput(pane.machine, pane.pane, text, ["enter"]);
        return { kind: "sent", note: "Sent your words" };
      } catch (e) {
        return stopped(`Declined, but your words were not sent: ${failure(e)}`);
      }
    },
  };
}

const isAllow = (c: PermissionChoiceView) => !c.kind?.startsWith("reject");

/** Why a second press is asked: what the command does, and that the answer outlives this call when it does. */
function permissionReason(w: WaitingView, c: PermissionChoiceView): string {
  const parts: string[] = [];
  if (w.risk && isAllow(c)) parts.push(w.risk);
  if (c.standing) parts.push(isAllow(c) ? "grants this permanently" : "rejects this permanently");
  return parts.join(" · ");
}

/** What an `ActionResult` that did not go through says; `changed` and `done` have their own treatment. */
const REFUSAL: Partial<Record<ActionResult["kind"], string>> = {
  tooSoon: "That came too soon after the request appeared. Press again.",
  nothingWaiting: "Nothing is waiting for an answer any more. Nothing was sent.",
};

function outcome(result: ActionResult, sent: string): AskOutcome {
  if (result.kind === "done" || result.kind === "queued") return { kind: "sent", note: sent };
  if (result.kind === "changed") return { kind: "changed", note: "" };
  return stopped(REFUSAL[result.kind] ?? `Not sent: ${result.message}`);
}

const KIND_WORDS: Record<string, string> = {
  execute: "Run a command",
  edit: "Edit a file",
  read: "Read a file",
  delete: "Delete a file",
  move: "Move a file",
  fetch: "Fetch a page",
  search: "Search",
  think: "Think",
};

/**
 * A permission request of an ACP session; the first of `session.view.waiting`, which the caller has checked is a
 * permission (a question is a form). The others behind it are counted.
 */
export function fromWaiting(w: WaitingView, session: { machine: string; id: string; view: SessionView }): Ask {
  const { machine, id } = session;
  const options: AskOption[] = w.choices.map((c) => {
    const risky = c.standing || (!!w.risk && isAllow(c));
    return {
      id: c.id,
      label: c.name,
      risky,
      reason: permissionReason(w, c) || (risky ? "this answer cannot be taken back" : ""),
      reject: !isAllow(c),
    };
  });
  const fail = (e: unknown): ActionResult => ({ kind: "stopped", message: failure(e) });
  return {
    identity: `${machine}/${id}/${w.requestId}/${w.digest}`,
    label: "Permission request",
    noun: "request",
    heading: KIND_WORDS[w.toolKind ?? ""] ?? "Permission request",
    detail: w.subject && w.title && w.title !== w.subject ? w.title : undefined,
    subject: w.subject ?? w.title ?? undefined,
    language: w.toolKind === "execute" ? "bash" : undefined,
    risk: w.risk ?? undefined,
    options,
    waitingElsewhere: Math.max(0, session.view.waiting.length - 1),
    async send(option) {
      const result = await Sessions.answerPermission(machine, id, w.requestId, w.digest, option.id).catch(fail);
      return outcome(result, `Sent: ${option.label}`);
    },
    async say(text) {
      const result = await Sessions.send(machine, id, text, [], []).catch(fail);
      return outcome(result, "Sent your words");
    },
    async cancel() {
      const result = await Sessions.dismiss(machine, id, w.requestId, w.digest).catch(fail);
      return outcome(result, "Request cancelled");
    },
    session,
  };
}

/** The permission at the head of a session's queue as an `Ask`; nothing when it is empty or a question (a form's, not the dock's). */
export function sessionAsk(machine: string, id: string, view: SessionView): Ask | undefined {
  const first = view.waiting[0];
  return first?.ask === "permission" ? fromWaiting(first, { machine, id, view }) : undefined;
}

/**
 * The option the reply field presses before it sends words: the first plain decline. Nothing when none declines
 * (the field is hidden), and never one that lasts or carries a risk (two presses is not what a quiet field does).
 */
export function replyTarget(ask: Ask): AskOption | undefined {
  return ask.options.find((o) => o.reject && !o.risky);
}
