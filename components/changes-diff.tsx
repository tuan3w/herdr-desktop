import { setAccessibilityFocus, signal, Text, View } from "nsh";

import type { ChangeView, DiffView } from "herdr-desktop/native";
import type { ViewRef } from "nsh/types";

import { FileNotes, NoteComposer } from "#components/changes-notes";
import { DiffBlock } from "#components/diff-block";
import { ActionMenu, Btn, Empty, Icon, IconButton, type MenuEntry, Skeleton } from "#kit";
import { KIND_WORD, statsText } from "#lib/changes";
import { CONTEXTS, type ChangesModel } from "#lib/changes-model";
import { viewFile } from "#lib/files";

/** Room the file header, the `Change n of m` line and the edge of the block take from the diff's own height. */
const CHROME = 76;
/** The least height the diff view gets, however little room the notes leave. */
const MIN_DIFF = 160;

const CONTEXT_CHOICES: readonly { lines: number; label: string }[] = [
  { lines: CONTEXTS[0], label: `${CONTEXTS[0]} lines` },
  { lines: CONTEXTS[1], label: `${CONTEXTS[1]} lines` },
  { lines: CONTEXTS[2], label: "Whole file" },
];

/**
 * The file's menu: what is about the file or the change in view first, then the two ways to take changes back, each after
 * a divider of its own so they are never next to each other. `Revert this change\u2026` sits right after the actions on a
 * change; `Revert this file\u2026` is last. Every row has an icon; the key hints are the ones that work from the tab.
 */
export function changeEntries(a: {
  /** Unchanged lines now shown around each change. */
  context: number;
  setContext: (lines: number) => void;
  canRevertChange: boolean;
  reload: () => void;
  note: () => void;
  revertChange: () => void;
  revertFile: () => void;
}): MenuEntry[] {
  return [
    { label: "Reload", icon: "refresh", shortcut: "r", onSelect: a.reload },
    { label: "Add a note on this change", icon: "pencil", shortcut: "c", onSelect: a.note },
    {
      label: "Context",
      icon: "list",
      items: [
        {
          type: "radio",
          value: String(a.context),
          onValueChange: (v) => a.setContext(Number(v)),
          closeOnClick: true,
          items: CONTEXT_CHOICES.map((c) => ({ value: String(c.lines), label: c.label })),
        },
      ],
    },
    "separator",
    {
      label: "Revert this change\u2026",
      icon: "undo",
      danger: true,
      disabled: !a.canRevertChange,
      onSelect: a.revertChange,
    },
    "separator",
    { label: "Revert this file\u2026", icon: "trash", danger: true, onSelect: a.revertFile },
  ];
}

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
  // The model steps through the choices; asking for one walks there (at most two steps, each announced).
  const setContext = (lines: number) => {
    for (let i = 0; i < CONTEXTS.length && model.context() !== lines; i++) model.cycleContext();
  };
  const entries = (c: ChangeView): MenuEntry[] =>
    changeEntries({
      context: model.context(),
      setContext,
      canRevertChange: canRevertGroup(),
      reload: () => void model.refresh(true),
      note: () => model.startNote(),
      revertChange: () => void model.revertGroup(),
      revertFile: () => void model.revertFile(c),
    });
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
              <Text class="text-xs text-muted-foreground">{text(c())}</Text>
            </View>
            {/* One primary per area: the next step is Mark reviewed; once done it is a quiet state. The keys are in the tooltip of the icon and in the shortcut sheet, not boxed inside buttons. */}
            <Btn
              small
              variant={model.reviewed(c()) ? "ghost" : "primary"}
              icon={model.reviewed(c()) ? "check" : undefined}
              label={model.reviewed(c()) ? "Mark not reviewed" : "Mark reviewed"}
              onPress={() => model.toggleReviewed(c())}
            />
            <IconButton
              icon="pencil"
              label="Add note"
              shortcut="c"
              buttonRef={(node) => {
                addButton = node;
              }}
              onPress={() => model.startNote()}
            />
            <ActionMenu small label="More for this file" icon="ellipsis" entries={entries(c())} />
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
                      showPath={false}
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
        </View>
      )}
    </If>
  );
}
