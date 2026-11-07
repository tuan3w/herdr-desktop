import { mount, Scroll, signal, Text, View } from "nsh";
import { FOCUS_RING, Modal, Popover, PopoverClose, PopoverDescription, PopoverTitle, PopupRoot, PreviewCard, ThemeRoot, Tipped, usePopover, useTriggerFocus } from "./kit";

/** Test entry only: every tooltip, popover and preview-card feature on one page, so `popups.test.tsx` can drive them. */
const last = signal("");
const applied = signal(0);
const dialog = signal(false);
const tall = Array.from({ length: 60 }, (_, i) => `Row ${String(i + 1).padStart(2, "0")}`);
const BUTTON = `h-8 items-center justify-center rounded-md border border-border px-3 ${FOCUS_RING}`;

/** A control that is a `View` with `onPress`, so nsh tells it when it takes the keyboard focus: it can show its tooltip. */
function FocusButton(props: { label: string }) {
  const focus = useTriggerFocus();
  return (
    <View role="button" accessibilityLabel={props.label} onPress={() => undefined} {...focus} class={BUTTON}>
      <Text class="text-sm text-foreground">{props.label}</Text>
    </View>
  );
}

function Apply() {
  const popover = usePopover();
  return (
    <View
      role="button"
      accessibilityLabel="Apply"
      onPress={() => {
        applied.set(applied() + 1);
        popover.close();
      }}
      {...popover.focus}
      class={BUTTON}
    >
      <Text class="text-sm text-foreground">Apply</Text>
    </View>
  );
}

function Columns() {
  return (
    <Popover
      onOpenChange={(open, change) => last.set(`${open ? "open" : "close"}: ${change.reason}`)}
      trigger={(t) => (
        <View role="button" accessibilityLabel="Choose columns" accessibilityState={{ expanded: t.expanded() }} onPress={t.onPress} onFocus={t.onFocus} onBlur={t.onBlur} class={BUTTON}>
          <Text class="text-sm text-foreground">Columns</Text>
        </View>
      )}
    >
      <View class="flex-row items-start justify-between gap-4">
        <PopoverTitle>Visible columns</PopoverTitle>
        <PopoverClose label="Close columns panel" />
      </View>
      <PopoverDescription>Choose the columns shown in the table.</PopoverDescription>
      <Apply />
      <Popover
        trigger={(t) => (
          <View role="button" accessibilityLabel="Add column" onPress={t.onPress} onFocus={t.onFocus} onBlur={t.onBlur} class="h-8 justify-center">
            <Text class="text-sm">Add</Text>
          </View>
        )}
      >
        <Text class="text-sm">Nested popover</Text>
      </Popover>
    </Popover>
  );
}

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 gap-4 bg-background p-6">
        <Text>{`Applied: ${applied()}`}</Text>
        <Text>{`Reason: ${last()}`}</Text>
        <View class="flex-row items-center gap-3">
          <Tipped label="Quick note" shortcut="⌘G">
            <FocusButton label="Note" />
          </Tipped>
          <Tipped label="Stays on press" closeOnClick={false} delay={0}>
            <FocusButton label="Keep tooltip" />
          </Tipped>
          <Tipped label="Turned off" disabled>
            <FocusButton label="No tooltip" />
          </Tipped>
          <Columns />
          <Popover
            label="Choose on hover"
            openOnHover
            delay={100}
            trigger={(t) => (
              <View role="button" accessibilityLabel="Hover" onPress={t.onPress} onFocus={t.onFocus} onBlur={t.onBlur} class={BUTTON}>
                <Text class="text-sm">Hover</Text>
              </View>
            )}
          >
            <Text class="text-sm">Hover content</Text>
          </Popover>
          <PreviewCard label="Session preview" card={() => <Text class="text-sm">Session SES-2410-001 · claude on laptop</Text>}>
            <Text class="font-mono text-sm">SES-2410-001</Text>
          </PreviewCard>
          <View role="button" accessibilityLabel="Open dialog" onPress={() => dialog.set(true)} class="h-8 justify-center">
            <Text class="text-sm">Open dialog</Text>
          </View>
        </View>
        <Scroll class="h-64 w-80 rounded-md border border-border" contentClass="gap-1 p-2">
          <Popover
            onOpenChange={(open, change) => last.set(`${open ? "open" : "close"} in list: ${change.reason}`)}
            trigger={(t) => (
              <View role="button" accessibilityLabel="Open in list" onPress={t.onPress} onFocus={t.onFocus} onBlur={t.onBlur} class={BUTTON}>
                <Text class="text-sm">Open in list</Text>
              </View>
            )}
          >
            <Text class="text-sm">Popover in list</Text>
          </Popover>
          <Each of={tall}>
            {(row) => (
              <Tipped label={`Tip ${row()}`}>
                <View accessibilityLabel={row()} class="h-8 justify-center">
                  <Text class="text-sm">{row()}</Text>
                </View>
              </Tipped>
            )}
          </Each>
        </Scroll>
        <Modal open={dialog()} onClose={() => dialog.set(false)} title="Test dialog">
          <View class="flex-row items-center gap-3">
            <Tipped label="Tip in dialog">
              <FocusButton label="Button in dialog" />
            </Tipped>
            <Columns />
          </View>
        </Modal>
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
