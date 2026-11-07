import { setAccessibilityFocus, signal, Text, View } from "nsh";

import type { ChangeView, DiffView } from "herdr-desktop/native";
import type { ViewRef } from "nsh/types";

import { FileNotes, NoteComposer } from "#components/changes-notes";
import { DiffBlock } from "#components/diff-block";
import { ActionMenu, Btn, Empty, Icon, IconButton, type MenuEntry, Skeleton } from "#kit";
import { KIND_WORD, plusMinus, statsText } from "#lib/changes";
import { CONTEXTS, type ChangesModel } from "#lib/changes-model";
import { viewFile } from "#lib/files";
import { keyLabel } from "#lib/shortcuts";

/** Room the file header, the `Change n of m` line and the edge of the block take from the diff's own height. */
const CHROME = 76;
/** The least height the diff view gets, however little room the notes leave. */
const MIN_DIFF = 160;

const contextText = (n: number): string => (n >= CONTEXTS[CONTEXTS.length - 1] ? "the whole file" : `${n} lines`);

/** What stands in for a diff when there is none to draw, and why. */
function NoPatch(props: { change: ChangeView; diff: DiffView; machine: string; root: string }) {
  const c = props.change;
  const open = () => viewFile(props.machine, `${props.root.replace(/\/+$/, "")}/${c.path}`);
  return (
    <If
      when={props.diff.conflicted}
      else={
        <If
          when={props.diff.binary}
          else={
            <If
              when={c.submodule}
              else={
                <Empty
                  title="No lines changed"
                  hint="Only the file's mode, or its time, is different from the last commit."
                />
              }
            >
              <Empty
                title="Another repository"
                hint={`${c.path} has its own git history. Review its changes from inside it.`}
              />
            </If>
          }
        >
          <Empty
            icon="file"
            title="Binary file"
            hint={`${statsText(c) || "It"} cannot be shown as lines. You can still mark it reviewed, or revert it.`}
          />
        </If>
      }
    >
      <Empty
        icon="alert"
        title="This file has merge conflicts"
        hint="Both sides changed the same lines and nobody chose. Resolve them in your editor or ask the agent to; reviewing and reverting wait until then."
      >
        <Btn label="Open the file" onPress={open} />
      </Empty>
    </If>
  );
}

/**
 * The right half: the selected file's change as a diff (`DiffBlock`: highlighted, words that changed marked, unchanged
 * stretches folded), a row of what can be done with it, the notes written on it and the one being written. Binary files,
 * conflicts and nested repositories say so instead of drawing nothing.
 */
export function ChangesDiff(props: { model: ChangesModel; onBack?: () => void }) {
  const model = props.model;
  const height = signal(0);
  let addButton: ViewRef | undefined;
  const change = () => model.selected();
  const room = () => Math.max(MIN_DIFF, height() - CHROME);
  const text = (c: ChangeView) => `${KIND_WORD[c.kind]}${c.oldPath ? ` \u00b7 from ${c.oldPath}` : ""}`;
  const canRevertGroup = () => {
    const c = change();
    return (
      (c?.kind === "modified" || c?.kind === "renamed") && model.group() >= 0 && !(model.diff()?.truncated ?? true)
    );
  };
  const entries = (c: ChangeView): MenuEntry[] => [
    { label: "Add a note on this change", icon: "pencil", shortcut: "c", onSelect: () => model.startNote() },
    {
      label: `Context: ${contextText(model.context())}, show more`,
      shortcut: "Enter",
      onSelect: () => model.cycleContext(),
    },
    { label: "Reload", icon: "refresh", onSelect: () => void model.refresh(true) },
    {
      label: "Revert this change\u2026",
      icon: "undo",
      danger: true,
      disabled: !canRevertGroup(),
      onSelect: () => void model.revertGroup(),
    },
    { label: "Revert this file\u2026", icon: "trash", danger: true, onSelect: () => void model.revertFile(c) },
  ];
  return (
    <If when={change()} else={<Empty fill icon="file" title="Pick a file" hint="Its change shows here." />}>
      {(c) => (
        <View role="group" accessibilityLabel={`Change to ${c().path}`} class="min-h-0 flex-1">
          <View class="min-h-12 flex-row items-center gap-2 border-b border-border px-4 py-2">
            <If when={props.onBack}>
              <IconButton icon="arrow-left" label="Back to the files" onPress={() => props.onBack?.()} />
            </If>
            <View class="min-w-0 flex-1">
              <Text class="text-sm font-medium text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
                {c().path}
              </Text>
              <Text class="text-xs text-muted-foreground">{`${text(c())}${c().added !== undefined ? ` \u00b7 ${plusMinus(c().added!, c().removed ?? 0)}` : ""}`}</Text>
            </View>
            <Btn
              small
              variant="ghost"
              icon={model.reviewed(c()) ? "check" : undefined}
              label={model.reviewed(c()) ? "Mark not reviewed" : "Mark reviewed"}
              hint="x"
              onPress={() => model.toggleReviewed(c())}
            />
            <Btn
              small
              icon="pencil"
              label="Add note"
              hint="c"
              buttonRef={(node) => {
                addButton = node;
              }}
              onPress={() => model.startNote()}
            />
            <ActionMenu label="More for this file" icon="ellipsis" entries={entries(c())} />
          </View>
          <View class="min-h-0 flex-1" onLayout={({ bounds }) => height.set(bounds.size.height)}>
            <If
              when={model.diff()}
              else={
                <If
                  when={model.diffFailure()}
                  else={
                    <View class="gap-2 p-4" accessibilityLabel="Reading the change" role="progressbar">
                      <Skeleton class="h-4 w-1/2" />
                      <Skeleton class="h-4 w-full" />
                      <Skeleton class="h-4 w-3/4" />
                    </View>
                  }
                >
                  {(why) => (
                    <Empty icon="alert" title="Cannot read this change" hint={why()}>
                      <Btn label="Try again" onPress={() => void model.refresh(true)} />
                    </Empty>
                  )}
                </If>
              }
            >
              {(d) => (
                <View class="min-h-0 flex-1 gap-2 px-4 pt-3">
                  <If
                    when={d().patch !== "" && !d().conflicted && !d().binary}
                    else={<NoPatch change={c()} diff={d()} machine={model.machine} root={model.root()} />}
                  >
                    <DiffBlock
                      path={d().path}
                      patch={d().patch}
                      context={model.context()}
                      created={c().kind === "added" || c().kind === "untracked"}
                      maxHeight={room()}
                      onReady={(steps) => model.attach(steps)}
                      onChange={(i) => model.setGroup(i)}
                    />
                  </If>
                  <If when={d().truncated}>
                    <View class="flex-row items-center gap-3 pb-1">
                      <Icon name="alert" size={14} tone="muted-foreground" />
                      <Text class="min-w-0 flex-1 text-xs text-muted-foreground">
                        {model.showAll()
                          ? `Showing the first ${d().lines} lines. The rest is too big to show here: open the file instead.`
                          : `Showing the first ${d().lines} lines of a bigger change.`}
                      </Text>
                      <If when={!model.showAll()}>
                        <Btn small label="Show all" onPress={() => model.setShowAll()} />
                      </If>
                    </View>
                  </If>
                </View>
              )}
            </If>
          </View>
          <FileNotes model={model} path={c().path} />
          <If when={model.composing()}>
            <NoteComposer model={model} onClosed={() => addButton && setAccessibilityFocus(addButton)} />
          </If>
          <Text class="px-4 pb-2 text-xs text-muted-foreground" accessibilityElementsHidden>
            {`j and k move between files · n and p between changes · c adds a note · x marks reviewed · ${keyLabel("changes")} opens this tab`}
          </Text>
        </View>
      )}
    </If>
  );
}
