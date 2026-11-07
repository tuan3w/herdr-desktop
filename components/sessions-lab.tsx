import { Herdr, Sessions } from "herdr-desktop/native";
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { ActionResult, SessionItem, SessionRef, SessionView } from "herdr-desktop/native";

/** Test entry only: the `Sessions` module on one page, against the scripted agent behind a real keeper (`sessions.test.tsx`). */
Herdr.configure({ dataDir: "", fixture: "empty" });

function Lab() {
  const ref = signal<SessionRef | undefined>(undefined);
  const view = signal<SessionView | undefined>(undefined);
  const items = signal<SessionItem[]>([]);
  const result = signal("no result yet");
  const failure = signal("no error");
  const needsYou = signal(0);
  const changes = signal(0);

  const pull = () => {
    const r = ref();
    if (!r) return;
    view.set(Sessions.view(r.machine, r.id) ?? undefined);
    items.set(Sessions.items(r.machine, r.id, 0, 200));
    needsYou.set(Herdr.board().counts.needsYou);
  };
  Herdr.onChange(() => {
    changes.update((n) => n + 1);
    pull();
  });

  const say = async (p: Promise<ActionResult>) => {
    const r = await p;
    result.set(`result ${r.kind}${r.message ? `: ${r.message}` : ""}`);
    pull();
  };
  const send = (text: string) => say(Sessions.send(ref()!.machine, ref()!.id, text, []));
  const waiting = () => view()?.waiting[0];
  const agentSaid = () =>
    items()
      .filter((i) => i.kind === "message" && i.role === "agent")
      .map((i) => i.text)
      .join(" | ");

  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Text>{`Phase: ${view()?.phase ?? "none"}`}</Text>
      <Text>{`Rows: ${view()?.itemCount ?? 0}`}</Text>
      <Text>{`Agent said: ${agentSaid() || "nothing"}`}</Text>
      <Text>{`Title: ${view()?.title ?? "none"}`}</Text>
      <Text>{`Waiting: ${
        waiting()
          ? `${waiting()!.ask} ${waiting()!.title ?? waiting()!.message} [${waiting()!
              .choices.map((c) => c.name)
              .join(", ")}]`
          : "nothing"
      }`}</Text>
      <Text>{`Needs you on the board: ${needsYou()}`}</Text>
      <Text>{`Options: ${
        view()
          ?.options.map((o) => o.name)
          .join(", ") || "none"
      }`}</Text>
      <Text>{`Changes heard: ${changes() > 0 ? "yes" : "no"}`}</Text>
      <Text>{result()}</Text>
      <Text>{failure()}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          onPress={async () => {
            try {
              const routes = await Sessions.probe("local");
              ref.set(await Sessions.start("local", { agent: routes[0]!.id, cwd: "/" }));
              pull();
            } catch (e) {
              failure.set((e as Error).message);
            }
          }}
        >
          <Text>Start a session</Text>
        </Button>
        <Button onPress={() => send("plain")}>
          <Text>Say plain</Text>
        </Button>
        <Button onPress={() => send("ask")}>
          <Text>Say ask</Text>
        </Button>
        <Button
          onPress={() => {
            const w = waiting()!;
            return say(
              Sessions.answerPermission(ref()!.machine, ref()!.id, w.requestId, "0000000000000000", w.choices[0]!.id),
            );
          }}
        >
          <Text>Allow with an old digest</Text>
        </Button>
        <Button
          onPress={() => {
            const w = waiting()!;
            return say(Sessions.answerPermission(ref()!.machine, ref()!.id, w.requestId, w.digest, w.choices[0]!.id));
          }}
        >
          <Text>Allow once</Text>
        </Button>
        <Button
          onPress={() => {
            const w = waiting()!;
            return say(Sessions.answerQuestion(ref()!.machine, ref()!.id, w.requestId, w.digest, [{ choice: 1 }]));
          }}
        >
          <Text>Answer the question</Text>
        </Button>
        <Button
          onPress={async () => {
            await Sessions.kill(ref()!.machine, ref()!.id);
            ref.set(undefined);
            view.set(undefined);
            result.set("result ended");
          }}
        >
          <Text>End the session</Text>
        </Button>
      </View>
    </View>
  );
}

mount(Lab);
