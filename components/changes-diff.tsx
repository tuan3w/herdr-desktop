import { setAccessibilityFocus, signal, Text, View } from "nsh";

import type { ChangeView, DiffView } from "herdr-desktop/native";
import type { ViewRef } from "nsh/types";

import { FileNotes, NoteComposer } from "#components/changes-notes";
import { DiffBlock } from "#components/diff-block";
import { ActionMenu, Btn, Empty, Icon, IconButton, type MenuEntry, NUM, Skeleton } from "#kit";
import { bulkyText, KIND_WORD, statsText } from "#lib/changes";
import { maySplit, mayWrap } from "#lib/changes-layout";
import { CONTEXTS, type ChangesModel } from "#lib/changes-model";
import { dirOf, nameOf } from "#lib/changes-tree";
import { viewFile } from "#lib/open-files";
import { codeWrap, diffSplit } from "#lib/settings";

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
 * Which file this is, whole: the name at reading size and under it its folder (muted), what happened to it and how much
 * changed. Both lines wrap rather than cut, so a long path is read in full; the tip of nothing is needed.
 */
function FileTitle(props: { change: ChangeView }) {
  const c = () => props.change;
  const dir = () => dirOf(c().path);
  const counted = () => !c().binary && !c().submodule && c().added != null;
  return (
    <View class="min-w-0 flex-1">
      <Text class="text-sm font-medium text-foreground">{nameOf(c().path)}</Text>
      <View class="flex-row flex-wrap items-baseline gap-x-2">
        <If when={dir() !== ""}>
          <Text class="text-xs text-muted-foreground">{`${dir()}/`}</Text>
        </If>
        <Text class="text-xs text-muted-foreground">
          {`${KIND_WORD[c().kind]}${c().oldPath ? ` \u00b7 from ${c().oldPath}` : ""}`}
        </Text>
        <If
          when={counted()}
          else={
            <Text style={NUM} class="text-xs text-muted-foreground">
              {statsText(c())}
            </Text>
          }
        >
          <Text style={NUM} class="text-xs text-success">{`+${c().added ?? 0}`}</Text>
          <Text style={NUM} class="text-xs text-destructive">{`\u2212${c().removed ?? 0}`}</Text>
        </If>
      </View>
    </View>
  );
}

/** `‹ 3 of 7 ›`: the previous and the next file of the list, the position between them. */
function Pager(props: { model: ChangesModel }) {
  const at = () => props.model.position();
  return (
    <View class="flex-row items-center gap-1" role="group" accessibilityLabel="Move between files">
      <IconButton
        icon="chevron-left"
        label="Previous file"
        shortcut="k"
        disabled={at().at <= 1}
        onPress={() => props.model.stepFile(-1)}
      />
      <Text style={NUM} class="min-w-12 text-center text-xs text-muted-foreground">
        {at().at > 0 ? `${at().at} of ${at().of}` : `${at().of} files`}
      </Text>
      <IconButton
        icon="chevron-right"
        label="Next file"
        shortcut="j"
        disabled={at().at >= at().of}
        onPress={() => props.model.stepFile(1)}
      />
    </View>
  );
}

/**
 * The right half: the selected file's change as a diff (`DiffBlock`: highlighted, words that changed marked, unchanged
 * stretches folded), a row of what can be done with it, the notes written on it and the one being written. Binary files,
 * conflicts and nested repositories say so instead of drawing nothing. In a pane too narrow for the list beside it (`bar`)
 * the head is one bar: the pager, the `Files` button that opens the list, the actions, and the file named whole below. A
 * pane too narrow for forty columns of code scrolls the code sideways instead of wrapping it (`width` is the diff's own).
 */
export function ChangesDiff(props: { model: ChangesModel; width: number; bar?: { onFiles: () => void } }) {
  const model = props.model;
  const height = signal(0);
  let addButton: ViewRef | undefined;
  const change = () => model.selected();
  const room = () => Math.max(MIN_DIFF, height() - CHROME);
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
  const actions = (c: ChangeView) => (
    <View class="shrink-0 flex-row items-center gap-2">
      {/* One primary per area: the next step is Mark reviewed, which moves on to the next file nobody has reviewed; once done it is a quiet state. */}
      <Btn
        small
        variant={model.reviewed(c) ? "ghost" : "primary"}
        icon={model.reviewed(c) ? "check" : undefined}
        label={model.reviewed(c) ? "Mark not reviewed" : "Mark reviewed"}
        onPress={() => model.toggleReviewed(c)}
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
      <ActionMenu small label="More for this file" icon="ellipsis" entries={entries(c)} />
    </View>
  );
  return (
    <If when={change()} else={<Empty fill icon="file" title="Pick a file" hint="Its change shows here." />}>
      {(c) => (
        <View role="group" accessibilityLabel={`Change to ${c().path}`} class="min-h-0 flex-1">
          <If
            when={props.bar}
            else={
              <View class="min-h-12 flex-row items-center gap-2 border-b border-border px-4 py-2">
                <FileTitle change={c()} />
                {actions(c())}
              </View>
            }
          >
            {(bar) => (
              <View class="gap-1 border-b border-border px-3 py-2">
                <View class="min-h-7 flex-row items-center gap-2">
                  <Pager model={model} />
                  <Btn small variant="outline" icon="list" label="Files" onPress={bar().onFiles} />
                  <View class="flex-1" />
                  {actions(c())}
                </View>
                <View class="px-1">
                  <FileTitle change={c()} />
                </View>
              </View>
            )}
          </If>
          <View class="min-h-0 flex-1" onLayout={({ bounds }) => height.set(bounds.size.height)}>
            <If
              when={!model.held()}
              else={
                <Empty
                  icon="file"
                  title={bulkyText(c())}
                  hint="Output a run wrote, not a change to read: it is not drawn until you ask."
                >
                  <Btn label="Open anyway" onPress={() => model.openAnyway()} />
                </Empty>
              }
            >
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
                        wrap={mayWrap(props.width) && codeWrap()}
                        split={maySplit(props.width) && diffSplit()}
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
