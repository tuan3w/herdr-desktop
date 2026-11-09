import { announce, cleanup, computed, effect, keymap, signal, Text, View } from "nsh";

import type { ChangeView, StatusView } from "herdr-desktop/native";
import type { InputRef } from "nsh/types";

import { ChangesDiff } from "#components/changes-diff";
import { ChangesList } from "#components/changes-list";
import { SendNotes } from "#components/changes-notes";
import { Btn, Clipped, dialogDepth, Empty, IconButton, NUM, Segmented, Skeleton, Tipped } from "#kit";
import { agentPart, filesText, identityFit, totalsOf } from "#lib/changes";
import { LIST_COLUMN, layoutFor } from "#lib/changes-layout";
import { createChanges } from "#lib/changes-model";
import { headerOnBand, mainInset } from "#lib/chrome";
import { BAR } from "#lib/layout";

/** The most the sheet of files is high, and the room it leaves around itself in the pane. */
const SHEET_MAX = 480;
const SHEET_GAP = 8;

/** What the header's cut project or branch fades into: the page. */
const FADE = "from-background/0 to-background";
/** The gaps between the header's four texts (`gap-1.5` three times), taken off the room before the parts are fitted. */
const IDENTITY_GAPS = 18;

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
  // The pane's own width, not the window's: Changes opens beside a chat, so the pane is often half of the window. Wide: the
  // files stand beside the diff. Narrower: one bar above the diff and the files in a sheet behind its `Files` button.
  const width = signal(0);
  const area = signal(0);
  const lay = computed(() => layoutFor(width()));
  const sheet = signal(false);
  let filter: InputRef | undefined;
  const status = () => model.status();
  const ready = () => status() !== null && !status()!.problem;

  const open = (c: ChangeView) => {
    model.select(c.path);
    sheet.set(false);
  };
  // The sheet takes the keyboard into its filter when it opens; Escape closes it; a wide pane has no sheet.
  effect(() => {
    if (!sheet()) return;
    if (lay().list === "column") {
      sheet.set(false);
      return;
    }
    const soon = setTimeout(() => filter?.focus(), 0);
    const off = keymap.bind("escape", () => sheet.set(false), { when: "always" });
    return () => {
      clearTimeout(soon);
      off();
    };
  });

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
        // The list of a narrow pane is a sheet; a wide pane has it beside the diff already.
        f: () => {
          if (lay().list === "bar") sheet.set(true);
        },
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

  // The header's own widths: the identity's share of the line and each part laid out once with no clamp, so an optional
  // part (the agent, then the machine) is whole or left out and never cut. Nothing optional shows before the first measure.
  const room = signal(0);
  const natural = signal<Record<string, number>>({});
  const measure = (key: string) => (e: { lines: { bounds: { size: { width: number } } }[] }) => {
    const width = Math.ceil(e.lines.reduce((sum, l) => sum + l.bounds.size.width, 0));
    if (natural()[key] !== width) natural.set({ ...natural(), [key]: width });
  };
  // A lean header drops what is secondary: `main · 4 ahead` is `main`.
  const branchText = () => (lay().lean ? model.branch().split(" \u00b7 ")[0] : model.branch());
  const branchPart = () => (branchText() ? `\u00b7 ${branchText()}` : "");
  const machinePart = () => (model.machineName() ? `\u00b7 ${model.machineName()}` : "");
  const agent = () => agentPart(model.agents());
  const agentWords = () => (agent().text ? `\u00b7 by ${agent().text}` : "");
  const fit = () => {
    const n = natural();
    return room() === 0
      ? { machine: false, agent: false }
      : identityFit({
          room: room() - IDENTITY_GAPS,
          project: n.project ?? 0,
          branch: n.branch ?? 0,
          machine: n.machine ?? 0,
          agent: n.agent ?? 0,
        });
  };
  const totals = () => totalsOf(model.files());
  const allDone = () => model.files().length > 0 && model.reviewedCount() === model.files().length;
  const reviewedText = () =>
    allDone() ? "All reviewed" : `${model.reviewedCount()} of ${model.files().length} reviewed`;
  const reading = () => status() === null && !model.failure();

  const scopeChoice = () => (
    <Segmented
      label="Which files"
      value={model.scope()}
      onChange={(v) => model.setScope(v)}
      options={[
        { value: "session", label: `This session \u00b7 ${model.counts().session}` },
        { value: "all", label: `Everything \u00b7 ${model.counts().all}` },
      ]}
    />
  );
  // The counts of the chosen scope. With a session the chips carry the number of files; without one this line does.
  const countsLine = () => (
    <View class="shrink-0 flex-row items-baseline gap-3">
      <If when={!model.hasSession()}>
        <Text style={NUM} class="text-xs text-muted-foreground">
          {filesText(totals().files)}
        </Text>
      </If>
      <If when={totals().added + totals().removed > 0}>
        <View class="flex-row items-baseline gap-1.5">
          <Text style={NUM} class="text-xs text-success">{`+${totals().added}`}</Text>
          <Text style={NUM} class="text-xs text-destructive">{`\u2212${totals().removed}`}</Text>
        </View>
      </If>
      <Text style={NUM} class={`text-xs ${model.reviewedCount() > 0 ? "text-foreground" : "text-muted-foreground"}`}>
        {reviewedText()}
      </Text>
    </View>
  );
  const scopeAndCounts = () => (
    <>
      <If when={model.hasSession()}>{scopeChoice()}</If>
      {countsLine()}
    </>
  );

  return (
    <View
      role="group"
      accessibilityLabel={`Changes in ${model.repoName()}`}
      class="relative min-h-0 min-w-0 flex-1 bg-background"
      onLayout={({ bounds }) => width.set(Math.round(bounds.size.width))}
    >
      <View class="border-b border-border">
        {/* Alone in the window this is the top band (`BAR`): it drags the window and keeps clear of its controls. */}
        <View
          desktop={{ windowDrag: headerOnBand() }}
          style={{
            minHeight: BAR,
            paddingLeft: 16 + (headerOnBand() ? mainInset().left : 0),
            paddingRight: 16 + (headerOnBand() ? mainInset().right : 0),
          }}
          class="flex-row items-center gap-3 py-1"
        >
          <View
            class="min-w-0 flex-1 flex-row items-baseline gap-1.5"
            onLayout={({ bounds }) => room.set(bounds.size.width)}
          >
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              class="pointer-events-none absolute left-0 top-0 opacity-0"
            >
              <Text class="text-sm font-medium" onTextLayout={measure("project")}>
                {model.repoName()}
              </Text>
              <Text class="text-xs" onTextLayout={measure("branch")}>
                {branchPart()}
              </Text>
              <Text class="text-xs" onTextLayout={measure("machine")}>
                {machinePart()}
              </Text>
              <Text class="text-xs" onTextLayout={measure("agent")}>
                {agentWords()}
              </Text>
            </View>
            <Clipped fade={[FADE]} boxClass="min-w-0 shrink" class="text-sm font-medium text-foreground">
              {model.repoName()}
            </Clipped>
            <If when={branchPart()}>
              <Clipped fade={[FADE]} boxClass="min-w-0 shrink" class="text-xs text-muted-foreground">
                {branchPart()}
              </Clipped>
            </If>
            <If when={fit().machine}>
              <Text style={{ numberOfLines: 1 }} class="shrink-0 text-xs text-muted-foreground">
                {machinePart()}
              </Text>
            </If>
            <If when={fit().agent}>
              <Tipped label={agent().tip}>
                <Text style={{ numberOfLines: 1 }} class="shrink-0 text-xs text-muted-foreground">
                  {agentWords()}
                </Text>
              </Tipped>
            </If>
          </View>
          <If when={reading()}>
            <Text class="shrink-0 text-xs text-muted-foreground">Reading changes{"\u2026"}</Text>
          </If>
          <If when={ready() && model.status()!.files.length > 0 && lay().header === "one"}>
            <View class="shrink-0 flex-row items-center gap-3">{scopeAndCounts()}</View>
          </If>
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
        <If when={ready() && model.status()!.files.length > 0 && lay().header === "two"}>
          <View class="min-h-8 flex-row flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2">{scopeAndCounts()}</View>
        </If>
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
              <View class="relative min-h-0 flex-1" onLayout={({ bounds }) => area.set(bounds.size.height)}>
                <View class="min-h-0 flex-1 flex-row">
                  <If when={lay().list === "column"}>
                    <View class="min-h-0 border-r border-border" style={{ width: LIST_COLUMN }}>
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
                  <View class="min-h-0 min-w-0 flex-1">
                    <ChangesDiff
                      model={model}
                      width={lay().diffWidth}
                      bar={lay().list === "bar" ? { onFiles: () => sheet.set(true) } : undefined}
                    />
                  </View>
                </View>
                <If when={sheet()}>
                  <View
                    role="button"
                    accessibilityLabel="Close the list of files"
                    onPress={() => sheet.set(false)}
                    class="absolute left-0 top-0 h-full w-full"
                  />
                  <View
                    role="group"
                    accessibilityLabel="Changed files"
                    class="absolute left-2 right-2 top-2 rounded-lg border border-border bg-popover"
                    style={{ height: Math.max(160, Math.min(SHEET_MAX, area() - 2 * SHEET_GAP)) }}
                  >
                    <ChangesList
                      model={model}
                      onOpen={open}
                      filterRef={(ref) => (filter = ref)}
                      onFocusChange={(inside) => listFocus.update((n) => Math.max(0, n + (inside ? 1 : -1)))}
                    />
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
