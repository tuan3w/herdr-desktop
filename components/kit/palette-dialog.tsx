import { type JSX, View } from "nsh";
import { Dialog } from "nsh/base";

import { paletteEnter } from "#lib/motion";

import { EDGE } from "./core";
import { newDialogId, topDialog, trackDialog } from "./dialog-stack";
import { escapeIsToasts, ToastHost } from "./notify";
import { createOpenState, type OpenChange, type OpenReason } from "./popup";
import { PopupRoot } from "./popup-root";

/**
 * The surface of the command palette and the Switcher: a card near the top of the window with no title bar, because its
 * search field is its header. It is a `Modal` for the keyboard (a dialog: focus trapped, returned to the opener on close,
 * only the newest dialog answers Escape and the scrim) with another face: top-anchored, 640 pt wide, never wider than the
 * window less its margin, and a faster entrance (`paletteEnter`). `onClose` hears `escape-key` and `outside-press`; the
 * owner closes by setting `open` false.
 */
export function PaletteDialog(props: {
  open: boolean;
  onClose: (change: OpenChange) => void;
  children?: JSX.Element;
  /** The card's name for screen readers (default "Command palette"): a text field is its only visible content. */
  label?: string;
  /** Called with the dialog's own focus request, so the owner can focus its field once the dialog is shown. */
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
    state.set(false, reason);
  };
  const pop = paletteEnter(() => props.open);
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
      <PopupRoot class="flex-1 items-center justify-start pt-16">
        <View
          testID="dialog-scrim"
          focusable={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => ask("outside-press")}
          class="absolute inset-0 bg-black/40"
        />
        <View
          style={pop}
          accessibilityLabel={props.label ?? "Command palette"}
          class={`max-h-[88%] w-[640px] max-w-[94%] overflow-hidden rounded-xl bg-popover ${EDGE.lg}`}
        >
          {props.children}
        </View>
        <ToastHost dialog={id} />
      </PopupRoot>
    </Dialog>
  );
}
