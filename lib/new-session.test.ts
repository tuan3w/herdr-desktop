import { expect, test } from "nsh/test";
import type { SessionInfo } from "herdr-desktop/native";
import { agentChoices, recentFolders, sessionFolderError, startFailure } from "#lib/new-session";

test("the agents a machine can run come first, and the ones it lacks follow, marked", () => {
  const choices = agentChoices([{ id: "omp", label: "omp" }]);
  expect(choices.map((c) => [c.id, c.installed])).toEqual([
    ["omp", true],
    ["claude", false],
    ["codex", false],
    ["pi", false],
  ]);
  // An agent the keeper knows and this list does not is still offered.
  expect(agentChoices([{ id: "newcomer", label: "Newcomer" }])[0]).toEqual({ id: "newcomer", label: "Newcomer", installed: true });
});

test("a folder is an absolute path or the machine's home, on one line", () => {
  expect(sessionFolderError("")).toContain("Enter the folder");
  expect(sessionFolderError("work/app")).toContain("absolute path");
  expect(sessionFolderError("/work/app")).toBeUndefined();
  expect(sessionFolderError("~")).toBeUndefined();
  expect(sessionFolderError("~/work")).toBeUndefined();
  expect(sessionFolderError("~other/work")).toContain("absolute path");
  expect(sessionFolderError("/a\nb")).toContain("one line");
});

test("every way a start fails says what happened in the keeper's words and what to do next", () => {
  // The texts are the ones `native/core/src/session/error.rs` and the keeper produce.
  const cases: [string, RegExp][] = [
    ["Agent sessions need python3 on this machine.", /Install python3 on box/],
    ["That agent isn’t installed on the machine.", /Install the agent on box/],
    ["The agent helper isn’t installed on the machine.", /installs its helper/],
    ["the folder does not exist on this host: /nope", /Check the folder: it must exist on box/],
    ["The agent exited while starting.", /Run the agent once in a terminal on box/],
    ["4 sessions are open on this machine already. Close one first.", /End or close one/],
    ["ssh: connect to host box port 22: Connection refused", /Check box in Machines/],
    ["something nobody planned for", /Nothing was started/],
  ];
  for (const [said, next] of cases) {
    const failure = startFailure(said, "box");
    expect(failure.text).toBe(said);
    expect(failure.next).toMatch(next);
  }
  expect(startFailure("  ", "box").text).toBe("The session did not start.");
});

test("the folders offered are the last one used, then where sessions and agents already work, once each", () => {
  const session = (cwd: string) => ({ cwd }) as SessionInfo;
  expect(recentFolders({ remembered: "/b", sessions: [session("/a"), session("/b")], agents: ["/c", "/a", " "] })).toEqual(["/b", "/a", "/c"]);
  expect(recentFolders({ sessions: [], agents: Array.from({ length: 20 }, (_, i) => `/f${i}`), limit: 3 })).toEqual(["/f0", "/f1", "/f2"]);
});
