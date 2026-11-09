import { effect, signal, untracked, View } from "nsh";

import { Btn, Field, FieldRow, Modal } from "#kit";

/**
 * One name to type: a new workspace, or a rename of a workspace, tab, pane or chat. Enter or the confirm button submits the
 * trimmed text. The button is off only while the text is what it already was (a rename to the same name is nothing to
 * confirm); pressed on an empty name it shows why under the field, as Enter does. `onSubmit` runs first, then `onClose`, so a caller that only reacts to the name never has to
 * close the dialog itself; Escape and Cancel call `onClose` alone. The text starts from `initial` each time it opens.
 * `allowEmpty` is for a name that can be taken away (a pane's label: empty shows the program's own title): the field is
 * not marked required, an empty name is a valid submit and `onSubmit("")` says so; `helper` is the line under the field.
 */
export function NameDialog(props: {
  open: boolean;
  title: string;
  initial?: string;
  confirm: string;
  allowEmpty?: boolean;
  helper?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const text = signal("");
  const attempted = signal(false);
  effect(() => {
    if (!props.open) return;
    untracked(() => {
      text.set(props.initial ?? "");
      attempted.set(false);
    });
  });
  const trimmed = () => text().trim();
  const changed = () => trimmed() !== (props.initial ?? "").trim();
  const canSubmit = () => (props.allowEmpty || trimmed() !== "") && changed();
  const submit = () => {
    if (!props.allowEmpty && trimmed() === "") {
      attempted.set(true);
      return;
    }
    if (!canSubmit()) return;
    props.onSubmit(trimmed());
    props.onClose();
  };
  return (
    <Modal
      open={props.open}
      onClose={() => props.onClose()}
      title={props.title}
      disablePointerDismissal={changed()}
      actions={
        <>
          <Btn variant="ghost" label="Cancel" onPress={() => props.onClose()} />
          {/* Never off for a missing name (`design/dialogs.md`): pressed, it says why under the field. Off only for an unchanged rename, where nothing can be done. */}
          <Btn
            variant="primary"
            label={props.confirm}
            hint="↵"
            disabled={(props.allowEmpty || trimmed() !== "") && !canSubmit()}
            onPress={submit}
          />
        </>
      }
    >
      <View class="gap-3">
        <FieldRow>
          <Field
            autoFocus
            label={props.allowEmpty ? "Name" : "Name *"}
            reserve
            value={text()}
            onChange={(v) => text.set(v)}
            onSubmit={submit}
            onBlur={() => attempted.set(true)}
            hint={props.helper}
            error={!props.allowEmpty && attempted() && trimmed() === "" ? "Give it a name." : undefined}
          />
        </FieldRow>
      </View>
    </Modal>
  );
}
