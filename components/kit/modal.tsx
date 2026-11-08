import { announce, effect, type JSX, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { AlertDialog, Dialog } from "nsh/base";

import { largeDialogSize } from "#lib/layout";
import { enterScale } from "#lib/motion";

import { EDGE } from "./core";
import { newDialogId, topDialog, trackDialog } from "./dialog-stack";
import { coverToasts, escapeIsToasts, ToastHost } from "./notify";
import { createOpenState, type OpenChange, type OpenReason } from "./popup";
import { PopupRoot } from "./popup-root";

/** Vertical padding of the scrolling body, which `Modal` adds to the content height to tell whether it overflows: 16 above, 16 over the footer or 24 when there is none (the dialog's own edge padding). */
const BODY_PAD = { footer: 32, none: 40 } as const;
/** Widths by kind (`design/dialogs.md`): a short question, a form, text the user writes, a picture. */
const WIDTH = { small: "w-[400px]", default: "w-[560px]", wide: "w-[760px]", huge: "w-[1000px]" } as const;

/**
 * A modal form or detail, as Base UI's Dialog behaves: scrim, popup that scales in from 0.97 and back out as the dialog closes, title, optional
 * description, content, and a footer of `actions` aligned right. Open it for rare, user-invoked tasks only. `wide`
 * (760pt, not 560) is for text the user writes, such as a prompt; `huge` (1000pt) is for a file browser or a viewer, where
 * the content is the point. `size="settings"` is the one large dialog (`DIALOG_LARGE`, 880 x 640, the window less a 24-pt
 * margin when it is smaller): its content fills the popup and brings its own layout (a list at the left, a scroll at the
 * right), under a header of the title and the `actions` at the top right, with no footer. `size="small"` (400 pt) is for
 * a short question (Confirm, Alert, Info), so two lines and two buttons are not a wide empty card. A dialog with no
 * `actions` has no footer band: its body ends at the dialog's edge padding.
 *
 * `open` is the owner's. Escape and a press on the scrim only ask: `onClose(change)` hears the `reason`
 * (`escape-key`, `outside-press`) and the owner closes by setting `open` false, or refuses by leaving it true (the
 * composer asks first). `disablePointerDismissal` keeps a press on the scrim from asking at all, for a dialog that holds
 * work the user typed. `onOpenChangeComplete(open)` runs once the enter or the exit has finished. Dialogs nest: only
 * the newest one answers Escape and the scrim (`dialog-stack.ts`); popups of the app that are open when a dialog opens
 * watch `dialogDepth()` and close first. Popups made inside a dialog are its own: it holds
 * a `PopupRoot` and the toasts of its root view, because a dialog is a root view and covers the app.
 *
 * In a window shorter than the content the popup stops at 94% of it: the title and the actions stay in view and only
 * the content scrolls, with a hairline under the title and over the actions while it does.
 */
export function Modal(props: {
  open: boolean;
  onClose: (change: OpenChange) => void;
  title: string;
  description?: string;
  children?: JSX.Element;
  actions?: JSX.Element;
  wide?: boolean;
  huge?: boolean;
  size?: "settings" | "small";
  disablePointerDismissal?: boolean;
  onOpenChangeComplete?: (open: boolean) => void;
}) {
  const id = newDialogId();
  trackDialog(id, () => props.open);
  const state = createOpenState({
    open: () => props.open,
    onOpenChange: (open, change) => {
      if (!open) props.onClose(change);
    },
  });
  const ask = (reason: OpenReason) => {
    if (topDialog() !== id) return;
    // Escape closes the newest toast while the toast region is held, not this dialog as well.
    if (reason === "escape-key" && escapeIsToasts()) return;
    if (reason === "outside-press" && props.disablePointerDismissal) return;
    state.set(false, reason);
  };
  const large = () => (props.size === "settings" ? largeDialogSize(windowSize()) : undefined);
  const pop = enterScale(() => props.open);
  const viewport = signal(0);
  const content = signal(0);
  // Whether a body and a footer were given, without reading them: `props.children` and `props.actions` are getters that
  // build their elements on every read, so a test of their value made the whole body twice (the copy no one saw kept its
  // effects and key bindings: a folder field's Down went to the hidden copy's list).
  const hasBody = "children" in props;
  const hasActions = "actions" in props;
  // No body (a question that is all title): nothing scrolls, and no hairline is drawn.
  const overflowing = () =>
    viewport() > 0 && content() + (hasActions ? BODY_PAD.footer : BODY_PAD.none) > viewport() + 1;
  const edge = () => (overflowing() ? "border-border" : "border-transparent");
  // A dialog has no name of its own: a screen reader hears that one opened, and which. Once per opening: a title that
  // changes while it is open (a counter, a name being typed) must not be read again at every change.
  let announced = false;
  effect(() => {
    const now = props.open;
    if (now && !announced)
      untracked(() => announce(props.description ? `${props.title}. ${props.description}` : props.title));
    announced = now;
  });
  // Built once, by `size`, so the ordinary dialog keeps exactly the tree it always had.
  const body = () =>
    props.size === "settings" ? (
      <View style={[pop, large()]} class={`rounded-xl bg-card ${EDGE.lg}`}>
        <View class="shrink-0 flex-row items-center gap-3 border-b border-border py-3 pl-6 pr-3">
          <View class="min-w-0 flex-1">
            <Text role="header" class="text-lg font-semibold text-card-foreground">
              {props.title}
            </Text>
          </View>
          {props.actions}
        </View>
        <View class="min-h-0 flex-1 overflow-hidden rounded-b-xl">{props.children}</View>
      </View>
    ) : (
      <View
        style={pop}
        class={`max-h-[94%] max-w-[94%] rounded-xl bg-card ${EDGE.lg} ${WIDTH[props.huge ? "huge" : props.wide ? "wide" : props.size === "small" ? "small" : "default"]}`}
      >
        <View class="min-h-0 shrink">
          <View class={`shrink-0 gap-1 border-b px-6 pb-4 pt-6 ${edge()}`}>
            <Text role="header" class="text-lg font-semibold text-card-foreground">
              {props.title}
            </Text>
            <If when={props.description}>
              <Text class="text-sm text-muted-foreground" style={{ userSelect: "text" }}>
                {props.description}
              </Text>
            </If>
          </View>
          {/* A dialog that is all title and buttons has no body: an empty one was a 32 pt blank band above the buttons. */}
          <If when={hasBody}>
            <Scroll
              class="min-h-0 shrink"
              contentClass={`px-6 pt-4 ${hasActions ? "pb-4" : "pb-6"}`}
              onLayout={({ bounds }) => viewport.set(bounds.size.height)}
            >
              <View onLayout={({ bounds }) => content.set(bounds.size.height)}>{props.children}</View>
            </Scroll>
          </If>
          <If when={hasActions}>
            <View class={`shrink-0 flex-row items-center justify-end gap-2 border-t px-6 pb-6 pt-4 ${edge()}`}>
              {props.actions}
            </View>
          </If>
        </View>
      </View>
    );
  // The scrim is the dialog's own, so a press on it is told apart from Escape and can be refused: nsh's backdrop reports
  // both as the same cancel without a reason.
  return (
    <Dialog
      open={props.open}
      animation="fade"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      onCancel={() => ask("escape-key")}
      onOpen={() => props.onOpenChangeComplete?.(true)}
      onClose={() => props.onOpenChangeComplete?.(false)}
      class="absolute inset-0"
    >
      <PopupRoot class="flex-1 items-center justify-center">
        <View
          testID="dialog-scrim"
          focusable={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => ask("outside-press")}
          class="absolute inset-0 bg-black/40"
        />
        {body()}
        <ToastHost dialog={id} />
      </PopupRoot>
    </Dialog>
  );
}

let asking = false;

/**
 * Asks before something that cannot be taken back (an `Undo` toast cannot restore it), as Base UI's AlertDialog does:
 * the system alert, never closed by a press outside it, `Cancel` first and the destructive action named by its verb;
 * Escape is `Cancel`. One question at a time: a second call while one is open answers false at once, so a double press
 * cannot stack alerts or confirm twice. The system alert covers everything, so the toasts wait under it and their time
 * is held until it closes (`coverToasts`). Resolves true
 * only when the destructive action is chosen.
 */
export async function confirmDestructive(options: {
  title: string;
  description: string;
  action: string;
}): Promise<boolean> {
  if (asking) return false;
  asking = true;
  // The toasts wait under the system alert: an Undo toast would run out while the question about it is open.
  const uncover = coverToasts();
  try {
    const choice = await AlertDialog.show({
      title: options.title,
      description: options.description,
      closeOnEscape: true,
      closeOnBackdropPress: false,
      actions: [
        { label: "Cancel", role: "cancel", id: "cancel" },
        { label: options.action, role: "destructive", id: "confirm" },
      ],
    });
    return choice.action === "confirm";
  } finally {
    asking = false;
    uncover();
  }
}
