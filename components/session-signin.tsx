import { announce, Clipboard, effect, Scroll, setAccessibilityFocus, signal, Text, View } from "nsh";
import type { Accessor, ViewRef } from "nsh";
import type { ActionKind, ActionResult, AuthMethodView, SessionView } from "herdr-desktop/native";
import type { SessionPort } from "../lib/session";
import { agentName, shellLine, visibleText } from "../lib/session-text";
import { Btn, Icon, notify } from "./kit";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a refusal says when the agent's own message is empty. */
const REFUSED: Partial<Record<ActionKind, string>> = {
  notReady: "The agent is not asking for a sign-in any more.",
  noSuchOption: "The agent does not offer that way to sign in.",
  busy: "The agent is busy. Try again in a moment.",
  ended: "The session has ended.",
};

/** What the sign-in card reads and does; `createSignin` makes one per chat. */
export interface Signin {
  /** The key of the action that is running (a method id, or `reopen`), or `null`. */
  busy: Accessor<string | null>;
  /** What the agent said when it refused, or why the call failed. */
  failure: Accessor<string | null>;
  /** The person asked the agent to try again after signing in elsewhere. */
  tried: Accessor<boolean>;
  /** The card sets this: called with the key of the action that just ended, to put the keyboard back on its button. */
  settled: (key: string) => void;
  /** The person is signed in, or the session is somewhere else now: nothing of an earlier attempt is true any more. */
  reset: () => void;
  run: (key: string, act: () => Promise<ActionResult>, retry: boolean) => Promise<void>;
  authenticate: (method: AuthMethodView) => Promise<void>;
  reopen: () => Promise<void>;
}

/**
 * What the sign-in of one chat remembers: which action is running, what the agent said when it refused, and whether the
 * person already asked it to try again. It lives in the chat, not in the card, because the card is gone while the agent
 * reopens the session and comes back if it still wants a sign-in; the refusal must survive that.
 */
export function createSignin(port: SessionPort): Signin {
  const busy = signal<string | null>(null);
  const failure = signal<string | null>(null);
  const tried = signal(false);
  const state: Signin = {
    busy,
    failure,
    tried,
    settled: () => undefined,
    reset: () => {
      failure.set(null);
      tried.set(false);
    },
    async run(key, act, retry) {
      if (busy() !== null) return;
      busy.set(key);
      failure.set(null);
      try {
        const result = await act();
        if (result.kind === "done" || result.kind === "queued") tried.set(retry);
        else failure.set(visibleText(result.message || REFUSED[result.kind] || "The agent did not take it."));
      } catch (e) {
        failure.set(visibleText(reason(e)));
      } finally {
        busy.set(null);
        state.settled(key);
      }
    },
    authenticate: (method) => state.run(method.id, () => port.authenticate(method.id), false),
    reopen: () => state.run("reopen", () => port.reopen(), true),
  };
  return state;
}

/** One way to sign in that the app carries out: a button named as the agent names it, and what the agent says about it. */
function AgentMethod(props: { method: AuthMethodView; signin: Signin; onNode: (id: string, node: ViewRef) => void }) {
  const working = () => props.signin.busy() === props.method.id;
  return (
    <View class="gap-1.5">
      <View class="flex-row">
        <Btn
          variant="primary"
          label={props.method.name}
          loading={working()}
          disabled={props.signin.busy() !== null && !working()}
          buttonRef={(node) => props.onNode(props.method.id, node)}
          onPress={() => void props.signin.authenticate(props.method)}
        />
      </View>
      <If when={props.method.description}>{(text) => <Text class="text-sm text-muted-foreground">{visibleText(text())}</Text>}</If>
    </View>
  );
}

/**
 * One way to sign in that the person does in a terminal on the agent's machine: what the agent said about it, the
 * arguments it gave (the app cannot run them for the person, and never opens a browser or a terminal by itself),
 * `Copy command`, and `I did it, try again`.
 */
function TerminalMethod(props: { method: AuthMethodView; where: string; signin: Signin; onNode: (id: string, node: ViewRef) => void }) {
  const line = () => shellLine(props.method.terminalArgs ?? []);
  const reopening = () => props.signin.busy() === "reopen";
  return (
    <View class="gap-2">
      <View class="gap-0.5">
        <View class="flex-row items-center gap-2">
          <Icon name="terminal" size={16} tone="muted-foreground" />
          <Text role="header" class="text-sm font-medium text-foreground">
            {props.method.name}
          </Text>
        </View>
        <If when={props.method.description}>{(text) => <Text class="text-sm text-muted-foreground">{visibleText(text())}</Text>}</If>
      </View>
      <Text class="text-sm text-foreground">{`In a terminal on ${props.where}, start the agent's program with these arguments, and follow what it asks:`}</Text>
      <View class="rounded-md border border-border bg-muted px-3 py-2">
        <Text style={{ userSelect: "text" }} class="font-mono text-sm text-foreground">
          {line() || "(no arguments)"}
        </Text>
      </View>
      <View class="flex-row flex-wrap gap-2">
        <Btn
          label="Copy command"
          name={`Copy command, ${props.method.name}`}
          disabled={line() === ""}
          buttonRef={(node) => props.onNode(`copy:${props.method.id}`, node)}
          onPress={() => void Clipboard.writeText(line()).then(() => notify("Command copied"))}
        />
        <Btn
          variant="primary"
          label="I did it, try again"
          loading={reopening()}
          disabled={props.signin.busy() !== null && !reopening()}
          buttonRef={(node) => props.onNode("reopen", node)}
          onPress={() => void props.signin.reopen()}
        />
      </View>
    </View>
  );
}

/**
 * Stands in for the conversation and the message box while the agent refuses the session until the person signs in
 * (`SessionView.phase` is `authRequired`). It says so plainly, offers one button per way the agent offers and the app can
 * carry out, and for a way done in a terminal gives the arguments and a button to try again once it is done. A refusal
 * or failure is the agent's own message under the buttons; the buttons stay. The card is told when it appears (a polite
 * `announce`: nsh 0.4.0 has no assertive one, `docs/ACCESSIBILITY.md`) and its title is an `alert`; the keyboard goes
 * to the first button once, when the tab is in front. `where` is the machine as a sentence says it (`this computer`).
 */
export function SessionSignin(props: { view: SessionView; where: string; active: boolean; signin: Signin }) {
  const agent = () => agentName(props.view.agent);
  const methods = () => props.view.acp.auth;
  announce(`${agent()} needs you to sign in`);
  const nodes = new Map<string, ViewRef>();
  const order: string[] = [];
  const onNode = (id: string, node: ViewRef) => {
    nodes.set(id, node);
    if (!order.includes(id)) order.push(id);
  };

  // A button that was busy is disabled, and a disabled view gives the focus up: after the answer it goes back.
  props.signin.settled = (key) => {
    const node = nodes.get(key) ?? nodes.get(order[0] ?? "");
    if (node) setTimeout(() => setAccessibilityFocus(node), 0);
  };
  let focused = false;
  effect(() => {
    if (!props.active || focused) return;
    focused = true;
    setTimeout(() => {
      const node = nodes.get(order[0] ?? "");
      if (node) setAccessibilityFocus(node);
    }, 0);
  });

  return (
    <Scroll class="min-h-0 flex-1">
      <View class="px-4 py-6">
        <View role="group" accessibilityLabel={`Sign in to ${agent()}`} class="w-full gap-4 rounded-lg border border-border bg-card p-5">
          <View role="alert" class="gap-1">
            <Text role="header" class="text-base font-medium text-foreground">{`${agent()} needs you to sign in`}</Text>
            <Text class="text-sm text-muted-foreground">{`It will not open this session until you do. Nothing you typed is lost, and ${agent()} carries on as soon as it accepts.`}</Text>
          </View>
          <Each of={methods()} key={(m: AuthMethodView) => m.id}>
            {(method) => (
              <If when={method().terminalArgs} else={<AgentMethod method={method()} signin={props.signin} onNode={onNode} />}>
                <TerminalMethod method={method()} where={props.where} signin={props.signin} onNode={onNode} />
              </If>
            )}
          </Each>
          <If when={methods().length === 0}>
            <Text class="text-sm text-foreground">The agent did not say how. Sign in to it outside this app, then press the button.</Text>
            <View class="flex-row">
              <Btn
                variant="primary"
                label="I did it, try again"
                loading={props.signin.busy() === "reopen"}
                buttonRef={(node) => onNode("reopen", node)}
                onPress={() => void props.signin.reopen()}
              />
            </View>
          </If>
          <If when={props.signin.failure()}>
            {(message) => (
              <View role="alert" class="flex-row items-start gap-2">
                <Icon name="alert" size={16} tone="destructive" />
                <Text class="min-w-0 flex-1 text-sm text-destructive">{message()}</Text>
              </View>
            )}
          </If>
          <If when={props.signin.tried() && !props.signin.failure()}>
            <Text role="alert" class="text-sm text-foreground">
              The agent still asks you to sign in.
            </Text>
          </If>
        </View>
      </View>
    </Scroll>
  );
}
