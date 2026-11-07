import { announce, cleanup, effect, keymap, Overlay, setAccessibilityFocus, signal, Text, View } from "nsh";
import { Toast, ToastStack } from "nsh/base";

import type { ViewRef } from "nsh/types";

import { DURATION, reducedMotion } from "#lib/motion";
import { keyLabel } from "#lib/shortcuts";

import { FOCUS_RING } from "./core";
import { dialogDepth, topDialog } from "./dialog-stack";
import { Kbd } from "./hint";
import { Icon } from "./icon";
import { Spinner } from "./loading";
import {
  createToasts,
  liveUndos,
  newestUndo,
  type PauseReason,
  type Settled,
  type ToastPriority,
  type ToastRecord,
  type ToastType,
  type UndoEntry,
} from "./toast-rules";

/**
 * Toasts, built on the manager model of Base UI's Toast (`toast-rules.ts`: timers with pause and resume, limit, priority,
 * de-duplication) and drawn by nsh's `ToastStack`. One timer exists while any toast has a deadline, none otherwise, and
 * with no toast no view is mounted.
 */

interface Data {
  undo?: () => void;
  onClose?: () => void;
  onRemove?: () => void;
}

/** What `notify` and the phases of `notifyPromise` take. */
export interface NotifyOptions {
  /** Restores what the toast reports. It runs once, from the button or Cmd+Z; Cmd+Z still reaches it after the toast is hidden. */
  undo?: () => void;
  /** A warning the user must not miss (data that could not be saved): high priority, 30 seconds. */
  lasting?: boolean;
  /** Names the toast: showing it again updates it in place and restarts its time. By default a plain text is its own name. */
  id?: string;
  type?: ToastType;
  priority?: ToastPriority;
  /** Milliseconds before it closes by itself; 0: it stays until the user closes it. */
  timeout?: number;
  /** The toast began to close, for whatever reason. */
  onClose?: () => void;
  /** The toast left the screen after its exit. */
  onRemove?: () => void;
}

/** One stage of `notifyPromise`. */
export interface Phase extends NotifyOptions {
  text: string;
}

const VISIBLE = 3;
/** Toasts kept at most, the ones the limit hides included. */
const KEEP = 30;
/** A toast with an Undo stays long enough to reach the pointer; a plain confirmation does not; a warning stays until read. */
const TIMEOUT = { undo: 10000, plain: 3500, lasting: 30000 } as const;
const APP_ROOT = "app";

const store = createToasts<Data>({
  limit: VISIBLE,
  keep: KEEP,
  timeout: TIMEOUT.plain,
  exitMs: () => (reducedMotion() ? 0 : DURATION.exit),
});
const shown = signal<ToastRecord<Data>[]>([]);
const region = signal(false);
const nodes = new Map<string, ViewRef>();
const focused = new Set<string>();
let undos: UndoEntry[] = [];
let promises = 0;
let wake: number | undefined;

const onScreen = (id: string) => store.get(id)?.status === "present" && !store.get(id)?.limited;

function settle(settled: Settled<Data>) {
  for (const toast of settled.closed) toast.data.onClose?.();
  for (const toast of settled.removed) toast.data.onRemove?.();
}

/** Shows what the manager holds and sets the one timer for what it needs next. Call it after every change. */
function commit() {
  const now = Date.now();
  undos = liveUndos(undos, now, onScreen);
  shown.set(store.shown());
  region.set(store.paused("region"));
  clearTimeout(wake);
  const wait = store.nextDue(now);
  wake = wait === null ? undefined : setTimeout(tick, wait);
}

function tick() {
  wake = undefined;
  settle(store.advance(Date.now()));
  commit();
}

function settings(text: string, options: NotifyOptions, fallback: ToastType) {
  const lasting = options.lasting === true;
  return {
    text,
    type: options.type ?? (lasting ? "warning" : fallback),
    priority: options.priority ?? (lasting ? "high" : "low"),
    timeout: options.timeout ?? (lasting ? TIMEOUT.lasting : options.undo ? TIMEOUT.undo : TIMEOUT.plain),
    data: { undo: options.undo, onClose: options.onClose, onRemove: options.onRemove },
  } as const;
}

function keepUndo(id: string, undo: (() => void) | undefined, timeout: number) {
  undos = undos.filter((entry) => entry.id !== id);
  if (undo) undos.push({ id, run: undo, until: Date.now() + (timeout > 0 ? timeout : TIMEOUT.undo) });
}

function say(text: string, undo: boolean) {
  announce(undo ? `${text}. Undo: ${keyLabel("undo")}` : text);
}

/**
 * Confirms what just happened. Pass `undo` for anything the user could not otherwise take back; the toast offers it
 * (a button, and Cmd+Z). `lasting` is for a warning the user must not miss. Returns the toast's id. The same plain text
 * shown again updates the toast already showing instead of stacking a second one.
 */
export function notify(text: string, options: NotifyOptions = {}): string {
  const set = settings(text, options, "success");
  const id = options.id ?? (options.undo ? undefined : `text:${text}`);
  const added = store.add({ id, ...set }, Date.now());
  settle(added.settled);
  keepUndo(added.id, options.undo, set.timeout);
  say(text, options.undo !== undefined);
  commit();
  return added.id;
}

/** Changes a toast that shows (text, type, undo, timeout) and restarts its time. A closed toast stays closed. */
export function updateToast(id: string, text: string, options: NotifyOptions = {}): boolean {
  const set = settings(text, options, "success");
  const result = store.update(id, set, Date.now());
  settle(result.settled);
  if (result.done) {
    keepUndo(id, options.undo, set.timeout);
    say(text, options.undo !== undefined);
  }
  commit();
  return result.done;
}

/** Closes one toast, or every toast (no `id`). It leaves after its exit. */
export function closeToast(id?: string) {
  const result = store.close(id, Date.now());
  settle(result.settled);
  for (const toast of result.closed) toast.data.onClose?.();
  commit();
}

/**
 * A toast for work that takes a while: `loading` shows at once and stays, then becomes `success` or `error` in place
 * (the same toast, with its own time). A phase that returns nothing closes the toast: there is nothing to say. When the
 * user closed the toast meanwhile, a success stays unsaid, but a failure (`type: "error"` or `lasting`) shows again as a
 * new toast: it must never be lost. The returned promise is the given one, so a rejection reaches the caller.
 */
export function notifyPromise<T>(
  promise: Promise<T>,
  phases: { loading: Phase; success: (value: T) => Phase | undefined; error: (error: unknown) => Phase | undefined },
): Promise<T> {
  // Its own name: two sends that say the same thing are two toasts.
  const id = notify(phases.loading.text, {
    ...phases.loading,
    id: phases.loading.id ?? `promise-${promises++}`,
    type: "loading",
  });
  const finish = (phase: Phase | undefined, fallback: ToastType) => {
    if (!phase) return closeToast(id);
    const type = phase.type ?? (phase.lasting ? "warning" : fallback);
    const options: NotifyOptions = { ...phase, type };
    if (!updateToast(id, phase.text, options) && (type === "error" || phase.lasting)) notify(phase.text, options);
  };
  return promise.then(
    (value) => {
      finish(phases.success(value), "success");
      return value;
    },
    (error: unknown) => {
      finish(phases.error(error), "error");
      throw error;
    },
  );
}

function undoToast(id: string): boolean {
  const entry = undos.find((e) => e.id === id);
  if (!entry) return false;
  // Taken before it runs: a second press, or Cmd+Z right after the button, finds nothing to do twice.
  undos = undos.filter((e) => e !== entry);
  closeToast(id);
  entry.run();
  return true;
}

/**
 * Runs the newest undo and closes its toast. It reaches a toast the user dismissed or the limit hides, while its time
 * lasts. False when there is nothing to undo, and while a dialog is open: the page behind a dialog is not the user's
 * to change (the button of a toast shown in the dialog still works).
 */
export function undoLast(): boolean {
  if (dialogDepth() > 0) return false;
  const entry = newestUndo(undos, Date.now(), onScreen);
  return entry ? undoToast(entry.id) : false;
}

function pauseFor(reason: PauseReason) {
  settle(store.pause(reason, Date.now()));
  commit();
}

function resumeFor(reason: PauseReason) {
  settle(store.resume(reason, Date.now()));
  commit();
}

function focusIn(id: string) {
  focused.add(id);
  pauseFor("focus");
}

function focusOut(id: string) {
  if (focused.delete(id) && focused.size === 0) resumeFor("focus");
}

/**
 * The keyboard way to the toasts (Base UI's F6): the timers stand still, the screen reader reads them newest first and
 * its cursor goes to the newest. Escape then closes the newest toast; the same shortcut leaves and lets time run again.
 * A view cannot take the focus from code, so a sighted keyboard user reaches Undo with Cmd+Z instead.
 */
export function focusToasts() {
  const list = store.shown();
  if (store.paused("region")) return resumeFor("region");
  if (list.length === 0) return;
  pauseFor("region");
  const newest = [...list].reverse().filter((t) => t.status === "present");
  if (newest.length === 0) return;
  announce(
    `${newest.length} notifications. ${newest.map((t) => t.text).join(". ")}. Esc closes the newest notification.`,
  );
  const node = nodes.get(newest[0].id);
  if (node) setAccessibilityFocus(node);
}

function ToastIcon(props: { type: ToastType }) {
  return (
    <>
      <If when={props.type === "loading"}>
        <Spinner size={16} tone="muted-foreground" />
      </If>
      <If when={props.type === "success"}>
        <Icon name="circle-check" tone="success" />
      </If>
      <If when={props.type === "warning"}>
        <Icon name="alert" tone="warning" />
      </If>
      <If when={props.type === "error"}>
        <Icon name="alert" tone="destructive" />
      </If>
      <If when={props.type === "info"}>
        <Icon name="alert" tone="info" />
      </If>
    </>
  );
}

/**
 * The buttons of a toast. Not `Btn`: nsh's `Button` reports no focus, and the timer must stand still while the keyboard
 * is on a toast (Base UI's viewport does the same). A view that takes presses reports `onFocus` when Tab reaches it.
 */
function ToastButton(props: {
  label: string;
  text?: string;
  icon: "undo" | "x";
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      class={`h-8 flex-row items-center justify-center gap-2 rounded-md hover:bg-accent active:bg-accent ${FOCUS_RING} ${props.text ? "px-3" : "w-8"}`}
    >
      <Icon name={props.icon} size={14} tone={props.disabled ? "muted-foreground" : "foreground"} />
      <If when={props.text}>
        <Text class={`text-xs font-medium ${props.disabled ? "text-muted-foreground" : "text-foreground"}`}>
          {props.text}
        </Text>
      </If>
      <If when={props.hint}>
        <Kbd keys={props.hint!} tone="muted" />
      </If>
    </View>
  );
}

function ToastItem(props: { toast: () => ToastRecord<Data> }) {
  const id = props.toast().id;
  const ending = () => props.toast().status === "ending";
  // A toast that stays has to be closable by the pointer; the others show the close button when the pointer or the keyboard is on them.
  const stays = () => props.toast().timeout === 0 || props.toast().type === "loading";
  cleanup(() => {
    nodes.delete(id);
    focusOut(id);
  });
  return (
    <Toast
      ref={(node: ViewRef) => nodes.set(id, node)}
      transitionStatus={props.toast().status}
      swipeDirection="down"
      onDismissRequest={() => closeToast(id)}
      class="group flex-row items-center gap-3 rounded-lg border border-border bg-popover py-2 pl-4 pr-2 shadow-lg"
    >
      <ToastIcon type={props.toast().type} />
      {/* Never cut: a toast is read once, and what it says is what the user acts on. */}
      <Text class="flex-1 text-sm text-popover-foreground" style={{ userSelect: "text" }}>
        {props.toast().text}
      </Text>
      <If when={props.toast().data.undo}>
        <ToastButton
          label="Undo"
          text="Undo"
          icon="undo"
          hint={keyLabel("undo")}
          disabled={ending()}
          onPress={() => undoToast(id)}
          onFocus={() => focusIn(id)}
          onBlur={() => focusOut(id)}
        />
      </If>
      <View class={stays() ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"}>
        <ToastButton
          label="Close notification"
          icon="x"
          onPress={() => closeToast(id)}
          onFocus={() => focusIn(id)}
          onBlur={() => focusOut(id)}
        />
      </View>
    </Toast>
  );
}

/**
 * Draws the toasts bottom center, in the root view that is on top: the app's, or the newest open dialog's (a dialog is a
 * root view of its own and covers the app, so a toast drawn in the app would sit under its scrim). `Modal` mounts one for
 * its dialog; `App.tsx` mounts the app's. Only one of them shows, so a toast is never drawn or read twice.
 */
export function ToastHost(props: { dialog?: string }) {
  const root = props.dialog ?? APP_ROOT;
  const here = () => (topDialog() ?? APP_ROOT) === root;
  effect(() => {
    if (!region() || !here()) return;
    return keymap.bind({ escape: () => closeNewest() }, { when: "always" });
  });
  return (
    <If when={here() && shown().length > 0}>
      <Overlay
        style={{ position: "absolute", bottom: 20, left: 0, right: 0, alignItems: "center", pointerEvents: "box-none" }}
      >
        <ToastStack
          class="w-[400px]"
          placement="bottomCenter"
          closeOnEscape={false}
          onExpandedChange={({ expanded }) => (expanded ? pauseFor("hover") : resumeFor("hover"))}
        >
          <Each of={shown()} key={(toast: ToastRecord<Data>) => toast.id}>
            {(toast) => <ToastItem toast={toast} />}
          </Each>
        </ToastStack>
      </Overlay>
    </If>
  );
}

function closeNewest() {
  const live = store.shown().filter((t) => t.status === "present");
  const newest = live.at(-1);
  if (newest) closeToast(newest.id);
  if (live.length <= 1) resumeFor("region");
}
