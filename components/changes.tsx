import { announce, cleanup, effect, keymap, signal, Text, View } from "nsh";

import type { ChangeView, StatusView } from "herdr-desktop/native";

import { ChangesDiff } from "#components/changes-diff";
import { ChangesList } from "#components/changes-list";
import { SendNotes } from "#components/changes-notes";
import { Btn, dialogDepth, Empty, IconButton, narrow, Skeleton, snug } from "#kit";
import { summaryText } from "#lib/changes";
import { createChanges } from "#lib/changes-model";

/** The width of the file list beside the diff, and its narrower form in a snug window. */
const LIST_WIDTH = 304;
const LIST_WIDTH_SNUG = 256;

/** What stands in for the tab when git has nothing to show: the folder is not a repository, the machine is away, git is missing. */
function Problem(props: { status: StatusView; onRetry: () => void }) {
  const title = () => {
    switch (props.status.problem) {
      case "notARepo":
        return "This folder is not a git repository";
      case "gitMissing":
        return "git is not installed here";
      case "unreachable":
        return "Cannot reach this machine";
      default:
        return "Cannot read the changes";
    }
  };
  const hint = () => {
    switch (props.status.problem) {
      case "notARepo":
        return "Changes are what differs from the last commit, so they need git. Run git init in this folder, or open an agent that works in a repository.";
      case "gitMissing":
        return props.status.message;
      default:
        return props.status.message;
    }
  };
  return (
    <Empty fill icon="alert" title={title()} hint={hint()}>
      <If when={props.status.problem !== "notARepo"}>
        <Btn label="Try again" onPress={props.onRetry} />
      </If>
    </Empty>
  );
}

/**
 * A checkout's Changes tab: what the agents changed since the last commit, to read and answer. Left, the changed files
 * in groups with how much changed in each and a filter; right, the selected file as a diff, with notes to write on it and
 * a way to take a change back. The notes go to the agent as one message after a preview. It reads git while it is in
 * front (`lib/changes-model.ts`) and draws nothing while it is not.
 *
 * Keys, while the tab is in front and no field is being typed in: `j` and `k` (and Up and Down while the list has the
 * keyboard) move between files, `n` and `p` between the changes of the file, `Enter` shows more unchanged lines around them,
 * `c` writes a note on the change in view, `x` marks the file reviewed, `r` reads again. `mod+Enter` previews the notes to
 * send them. `design/changes.md` says why.
 */
export function Changes(props: { machine: string; cwd: string; active: boolean }) {
  const model = createChanges(props.machine, props.cwd, () => props.active);
  const sending = signal(false);
  const listFocus = signal(0);
  // Narrow window: the list or the diff, one at a time; wide: both.
  const diffFirst = signal(false);
  const one = () => narrow();
  const showList = () => !one() || !diffFirst();
  const showDiff = () => !one() || diffFirst();
  const status = () => model.status();
  const ready = () => status() !== null && !status()!.problem;

  const open = (c: ChangeView) => {
    model.select(c.path);
    diffFirst.set(true);
  };

  const openSend = () => {
    if (model.notes().length === 0) {
      announce("No notes to send yet: press c on a change to write one");
      return;
    }
    if (model.composing()) model.saveNote();
    sending.set(true);
  };

  // Keys of the tab, bound while it is in front and nothing modal is open. A letter key never fires inside a text field.
  effect(() => {
    if (!props.active || dialogDepth() > 0) return;
    const plain = keymap.bind(
      {
        j: () => model.stepFile(1),
        k: () => model.stepFile(-1),
        n: () => model.stepChange(1),
        p: () => model.stepChange(-1),
        c: () => model.startNote(),
        x: () => {
          const c = model.selected();
          if (c) model.toggleReviewed(c);
        },
        r: () => void model.refresh(true),
        enter: () => {
          if (listFocus() === 0 && model.selected()) model.cycleContext();
        },
      },
      { when: "notEditing" },
    );
    const always = keymap.bind("mod+enter", openSend, { when: "always" });
    return () => {
      plain();
      always();
    };
  });
  effect(() => {
    if (!props.active || listFocus() === 0 || dialogDepth() > 0) return;
    return keymap.bind({ down: () => model.stepFile(1), up: () => model.stepFile(-1) }, { when: "notEditing" });
  });
  cleanup(() => model.attach(null));

  const header = () => {
    const files = model.files();
    const parts = [summaryText(files)];
    const done = model.reviewedCount();
    if (files.length > 0 && done > 0) parts.push(`${done} reviewed`);
    return parts.join(" \u00b7 ");
  };

  return (
    <View
      role="group"
      accessibilityLabel={`Changes in ${model.repoName()}`}
      class="min-h-0 min-w-0 flex-1 bg-background"
    >
      <View class="min-h-14 flex-row items-center gap-3 border-b border-border px-6 py-2">
        <View class="min-w-0 flex-1">
          <Text class="text-sm font-medium text-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {`Changes in ${model.repoName()}`}
          </Text>
          <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {[model.branch(), ready() ? header() : ""].filter(Boolean).join(" \u00b7 ")}
          </Text>
        </View>
        <If when={model.notes().length > 0}>
          <Btn
            variant="primary"
            small
            label={`Send ${model.notes().length} ${model.notes().length === 1 ? "note" : "notes"}`}
            hint={keymap.label("mod+enter")}
            onPress={openSend}
          />
        </If>
        <IconButton icon="refresh" label="Reload changes" shortcut="r" onPress={() => void model.refresh(true)} />
      </View>
      <If
        when={status()}
        else={
          <If
            when={model.failure()}
            else={
              <View class="gap-2 p-6" role="progressbar" accessibilityLabel="Reading the changes">
                <Skeleton class="h-4 w-1/3" />
                <Skeleton class="h-4 w-1/2" />
                <Skeleton class="h-4 w-2/5" />
              </View>
            }
          >
            {(why) => (
              <Empty fill icon="alert" title="Cannot read the changes" hint={why()}>
                <Btn label="Try again" onPress={() => void model.refresh(true)} />
              </Empty>
            )}
          </If>
        }
      >
        {(s) => (
          <If when={!s().problem} else={<Problem status={s()} onRetry={() => void model.refresh(true)} />}>
            <If
              when={s().files.length > 0}
              else={
                <Empty
                  fill
                  icon="circle-check"
                  title="No changes"
                  hint={`Everything in ${model.repoName()} matches ${s().unborn ? "what is staged" : `the last commit${s().branch ? ` on ${s().branch}` : ""}`}. This reads again as agents work.`}
                />
              }
            >
              <View class="min-h-0 flex-1 flex-row">
                <If when={showList()}>
                  <View
                    class={`min-h-0 border-border ${one() ? "flex-1" : "border-r"}`}
                    style={one() ? undefined : { width: snug() ? LIST_WIDTH_SNUG : LIST_WIDTH }}
                  >
                    <ChangesList
                      model={model}
                      onOpen={open}
                      onFocusChange={(inside) => listFocus.update((n) => Math.max(0, n + (inside ? 1 : -1)))}
                    />
                    <If when={s().truncated}>
                      <Text class="px-4 pb-3 text-xs text-muted-foreground">
                        More files changed than are listed here. Commit or revert some to see the rest.
                      </Text>
                    </If>
                  </View>
                </If>
                <If when={showDiff()}>
                  <View class="min-h-0 min-w-0 flex-1">
                    <ChangesDiff model={model} onBack={one() ? () => diffFirst.set(false) : undefined} />
                  </View>
                </If>
              </View>
            </If>
          </If>
        )}
      </If>
      <SendNotes model={model} open={sending()} onClose={() => sending.set(false)} />
    </View>
  );
}
