import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Herdr } from "herdr-desktop/native";

/** Test entry only: the engine seam on one page, so `herdr.test.tsx` can drive it against the `mixed` fixture. */
Herdr.configure({ dataDir: "", fixture: "mixed" });

/** The pane of the first blocked agent in the fixture (a Claude Code bash permission screen). */
const BASH_PANE = "w1:p1";

function Lab() {
  const board = signal(Herdr.board());
  const link = signal(Herdr.machineStatuses()[0]?.state);
  const changes = signal(0);
  const answer = signal("no answer yet");
  const sent = signal("nothing sent");
  const failure = signal("no error");

  Herdr.onChange(() => {
    board.set(Herdr.board());
    link.set(Herdr.machineStatuses()[0]?.state);
    changes.update((n) => n + 1);
  });

  const row = (pane: string) =>
    [...board().needsYou, ...board().toReview, ...board().working, ...board().idle].find((r) => r.paneId === pane);
  const prompt = () => row(BASH_PANE)?.prompt;

  const describe = async (p: Promise<{ kind: string }>) => {
    const result = await p;
    answer.set(`answer ${result.kind}`);
    const keys = Herdr.testRequests("pane.send_keys").map((r) => JSON.stringify(r.params));
    sent.set(keys.length ? `sent ${keys.join(" ")}` : "nothing sent");
  };

  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Text>{`Status: ${board().statusLine}`}</Text>
      <Text>{`Title: ${board().title}`}</Text>
      <Text>{`Needs you: ${board().counts.needsYou}`}</Text>
      <Text>{`To review: ${board().counts.toReview}`}</Text>
      <Text>{`Working: ${board().counts.working}`}</Text>
      <Text>{`Idle: ${board().counts.idle}`}</Text>
      <Text>{`Needs you rows: ${board().needsYou.map((r) => r.name).join(", ")}`}</Text>
      <Text>{`Working rows: ${board().working.map((r) => r.name).join(", ")}`}</Text>
      <Text>{`Question: ${prompt()?.question ?? "none yet"}`}</Text>
      <Text>{`Options: ${prompt()?.options.map((o) => o.label + (o.riskReason ? ` (${o.riskReason})` : "")).join(" | ") ?? "none yet"}`}</Text>
      <Text>{`Preview: ${row("w1:p4")?.preview.slice(-1)[0]?.trim() ?? "none yet"}`}</Text>
      <Text>{`Machines: ${Herdr.machines().map((m) => m.name).join(", ")}`}</Text>
      <Text>{`Link: ${link()}`}</Text>
      <Text>{`Changes heard: ${changes()}`}</Text>
      <Text>{answer()}</Text>
      <Text>{sent()}</Text>
      <Text>{failure()}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          onPress={() =>
            Herdr.testPush({
              event: "pane_updated",
              data: {
                pane: {
                  pane_id: "w1:p4",
                  workspace_id: "w1",
                  tab_id: "w1:t1",
                  agent: "omp",
                  agent_status: "working",
                  cwd: "/home/dev/payments-api",
                  label: "renamed by test",
                  revision: 99,
                },
              },
            })
          }
        >
          <Text>Rename working agent</Text>
        </Button>
        <Button onPress={() => describe(Herdr.answer("local", BASH_PANE, prompt()!.digest, 0))}>
          <Text>Answer first option</Text>
        </Button>
        <Button onPress={() => describe(Herdr.answer("local", BASH_PANE, "0000000000000000", 0))}>
          <Text>Answer with an old digest</Text>
        </Button>
        <Button
          onPress={async () => {
            // The agent moved on to another command between the person looking and answering.
            const rows = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No"];
            Herdr.testSetScreen(BASH_PANE, rows);
            await describe(Herdr.answer("local", BASH_PANE, prompt()!.digest, 0));
          }}
        >
          <Text>Answer after the screen changed</Text>
        </Button>
        <Button onPress={() => Herdr.review(board().toReview.map((r) => r.reviewKey))}>
          <Text>Review finished</Text>
        </Button>
        <Button
          onPress={() => {
            try {
              Herdr.saveMachine({ name: "Evil", dest: "-oProxyCommand=x", enabled: true });
              failure.set("saved");
            } catch (e) {
              failure.set((e as Error).message);
            }
          }}
        >
          <Text>Save a bad machine</Text>
        </Button>
      </View>
    </View>
  );
}

mount(Lab);
