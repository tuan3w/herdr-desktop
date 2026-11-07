import { announce, effect, type JSX, Scroll, signal, Text, View } from "nsh";
import { AlertDialog, Dialog } from "nsh/base";
import { enterScale } from "#lib/motion";
import { newDialogId, topDialog, trackDialog } from "./dialog-stack";
import { ToastHost } from "./notify";
import { createOpenState, type OpenChange, type OpenReason } from "./popup";
import { PopupRoot } from "./popup-root";

/** Vertical padding of the scrolling body, which `Modal` adds to the content height to tell whether it overflows. */
const BODY_PAD = 32;

/**
 * A modal form or detail, as Base UI's Dialog behaves: scrim, popup that scales in from 0.97, title, optional
 * description, content, and a footer of `actions` aligned right. Open it for rare, user-invoked tasks only. `wide`
 * (760pt, not 560) is for text the user writes, such as a prompt; `huge` (1000pt) is for a file browser or a viewer, where
 * the content is the point.
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
    if (reason === "outside-press" && props.disablePointerDismissal) return;
    state.set(false, reason);
  };
  const pop = enterScale(() => props.open);
  const viewport = signal(0);
  const content = signal(0);
  const overflowing = () => content() + BODY_PAD > viewport() + 1;
  const edge = () => (overflowing() ? "border-border" : "border-transparent");
  // A dialog has no name of its own: a screen reader hears that one opened, and which.
  effect(() => {
    if (props.open) announce(props.description ? `${props.title}. ${props.description}` : props.title);
  });
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
        <View style={pop} class={`max-h-[94%] max-w-[94%] rounded-lg border border-border bg-card shadow-lg ${props.huge ? "w-[1000px]" : props.wide ? "w-[760px]" : "w-[560px]"}`}>
          <View class="min-h-0 shrink">
            <View class={`shrink-0 gap-1 border-b px-6 pb-4 pt-6 ${edge()}`}>
              <Text role="header" class="text-lg font-semibold text-card-foreground">
                {props.title}
              </Text>
              <If when={props.description}>
                <Text class="text-sm text-muted-foreground">{props.description}</Text>
              </If>
            </View>
            <Scroll class="min-h-0 shrink" contentClass="px-6 py-4" onLayout={({ bounds }) => viewport.set(bounds.size.height)}>
              <View onLayout={({ bounds }) => content.set(bounds.size.height)}>{props.children}</View>
            </Scroll>
            <View class={`shrink-0 flex-row items-center justify-end gap-2 border-t px-6 pb-6 pt-4 ${edge()}`}>{props.actions}</View>
          </View>
        </View>
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
 * cannot stack alerts or confirm twice. The system alert covers everything, so the toasts wait under it. Resolves true
 * only when the destructive action is chosen.
 */
export async function confirmDestructive(options: { title: string; description: string; action: string }): Promise<boolean> {
  if (asking) return false;
  asking = true;
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
  }
}
