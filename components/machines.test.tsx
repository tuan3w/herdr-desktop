import { expect, open, test } from "nsh/test";

import type { App } from "nsh/test";

import { destinationError } from "#lib/machine-rules";

const DESKTOP = { width: 1280, height: 800 };
const NAME = "label:Name *";
const DEST = "label:Destination *";
/** `.invalid` never resolves (RFC 6761): the machine is added, its link fails fast and never reaches anything. */
const UNREACHABLE = "devbox.invalid";

async function inMachines(): Promise<App> {
  const app = await open("./machines-lab.tsx", DESKTOP);
  await app.press("Open machines");
  await app.waitFor("Connected · herdr 0.9.5");
  return app;
}

async function addMachine(app: App, name: string, dest = UNREACHABLE) {
  await app.press("Add machine");
  await app.type(NAME, name);
  await app.type(DEST, dest);
  await app.press("Add");
  await app.waitFor("Add", { state: "gone" });
}

test("this computer is listed with its link, its agents and how many need you, and cannot be edited or removed", async () => {
  const app = await inMachines();
  expect(app.shows("This computer")).toBe(true);
  expect(app.shows("8 agents")).toBe(true);
  expect(app.shows("2 need you")).toBe(true);
  expect(app.count("label:/^(Edit|Remove|Retry|Connect to) /")).toBe(0);
});

test("a machine that is added appears in the list, link state and all, and the form closes", async () => {
  const app = await inMachines();
  await addMachine(app, "Build box");
  expect(app.texts()).toContain("machines=2");
  expect(app.shows("Build box")).toBe(true);
  expect(app.shows(UNREACHABLE)).toBe(true);
  // an unreachable machine says so and offers a retry instead of looking connected
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Not connected")));
  expect(app.shows("label:Retry Build box")).toBe(true);
});

test("a destination that could reach ssh as an option or into a shell is refused in the form, and nothing is added", async () => {
  const app = await inMachines();
  await app.press("Add machine");
  await app.type(NAME, "Evil");
  for (const hostile of ["-oProxyCommand=touch /tmp/pwned", "host name", "box;rm -rf ~", "`id`", "$(id)", "x'y"]) {
    await app.clear(DEST);
    await app.type(DEST, hostile);
    await app.press("Add");
    // the form stays open and says what is wrong with the destination
    expect(app.shows("label:Name *")).toBe(true);
    expect(app.texts()).toContain(destinationError(hostile));
  }
  await app.press("Cancel");
  await app.waitFor("label:Name *", { state: "gone" });
  expect(app.texts()).toContain("machines=1");
});

test("a field's mistake shows when it is left, a missing name on submit, and goes when fixed; what was typed stays", async () => {
  const app = await inMachines();
  await app.press("Add machine");
  await app.type(DEST, "-x");
  const quiet = app.texts();
  // leaving the field is what shows it, not typing
  await app.type("label:herdr session", "bad session");
  expect(app.texts().filter((t) => !quiet.includes(t)).length).toBeGreaterThan(0);

  await app.press("Add");
  expect(app.texts()).toContain("machines=1");
  expect(app.value(DEST)).toBe("-x");
  expect(app.value("label:herdr session")).toBe("bad session");

  await app.clear(DEST);
  await app.type(DEST, "ok-host");
  expect(app.texts()).not.toContain(destinationError("-x"));
});

test("a connection test that fails says why, keeps what was typed and can be run again; it adds no machine", async () => {
  const app = await inMachines();
  await app.press("Add machine");
  await app.type(NAME, "Build box");
  await app.type(DEST, "nosuch.invalid");
  const before = app.texts();
  await app.press("Test connection");
  await app.waitUntil(
    () =>
      app.texts().some((t) => !before.includes(t) && !t.startsWith("Connected")) &&
      !app.shows("label:Test connection, busy"),
    { timeout: 30000 },
  );
  const said = app.texts().filter((t) => !before.includes(t));
  expect(said.length).toBe(1);
  expect(said[0]).not.toMatch(/^Connected/);
  expect(app.value(DEST)).toBe("nosuch.invalid");
  expect(app.texts()).toContain("machines=1");
  // an edit makes the result stale: it describes the old destination
  await app.type(DEST, "x");
  expect(app.texts()).not.toContain(said[0]);
  expect(app.enabled("Test connection")).toBe(true);
});

test("a test needs a destination: an empty one would test this computer, so it asks for one", async () => {
  const app = await inMachines();
  await app.press("Add machine");
  const before = app.texts();
  await app.press("Test connection");
  expect(app.texts().filter((t) => !before.includes(t)).length).toBeGreaterThan(0);
  expect(app.shows("label:Test connection, busy")).toBe(false);
});

test("removing a machine asks first: cancel keeps it, the destructive answer removes it and its row", async () => {
  const app = await inMachines();
  await addMachine(app, "Build box");
  app.onDialog(() => "Cancel");
  await app.press("label:Remove Build box");
  expect(app.dialogs().length).toBe(1);
  expect(app.texts()).toContain("machines=2");
  expect(app.shows("Build box")).toBe(true);

  app.onDialog(() => "Remove machine");
  await app.press("label:Remove Build box");
  await app.waitUntil(() => app.texts().includes("machines=1"));
  expect(app.shows("Build box")).toBe(false);
});

test("switching a machine off shows it off, and on again reconnects it", async () => {
  const app = await inMachines();
  await addMachine(app, "Build box");
  await app.press("label:Connect to Build box");
  await app.waitFor("Switched off");
  expect(app.shows("label:Retry Build box")).toBe(false);
  await app.press("label:Connect to Build box");
  await app.waitUntil(() => !app.shows("Switched off"));
});

test("editing opens with the machine's values and saves the new name in the list", async () => {
  const app = await inMachines();
  await addMachine(app, "Build box");
  await app.press("label:Edit Build box");
  expect(app.value(NAME)).toBe("Build box");
  expect(app.value(DEST)).toBe(UNREACHABLE);
  await app.clear(NAME);
  await app.type(NAME, "Build farm");
  await app.press("Save");
  await app.waitFor("Build farm");
  expect(app.shows("Build box")).toBe(false);
  expect(app.texts()).toContain("machines=2");
});

test("when herdr refuses a save, its message shows and the form keeps what was typed", async () => {
  const app = await inMachines();
  await addMachine(app, "Build box");
  await app.press("label:Edit Build box");
  await app.clear(NAME);
  await app.type(NAME, "Renamed");
  // the machine goes away while its form is open: the engine refuses the save
  await app.press("Forget the remote machine");
  await app.waitUntil(() => app.texts().includes("machines=1"));
  const before = app.texts();
  await app.press("Save");
  expect(app.shows(NAME)).toBe(true);
  expect(app.value(NAME)).toBe("Renamed");
  expect(
    app
      .texts()
      .filter((t) => !before.includes(t))
      .some((t) => t.length > 0),
  ).toBe(true);
});

test("the form says that ssh signs in, and has no password or key field", async () => {
  const app = await inMachines();
  await app.press("Add machine");
  expect(app.count("label:/password|key/i")).toBe(0);
  expect(app.texts().some((t) => t.includes("ssh") && t.includes("once in a terminal"))).toBe(true);
});

test("a host key that changed needs the person: it says what to do, stops retrying and offers Retry", async () => {
  const app = await inMachines();
  await app.press("Script ssh failures");
  await addMachine(app, "Vault", "changed.example");
  await app.waitUntil(() =>
    app.texts().some((t) => t.startsWith("Needs attention: The host key of changed.example has changed")),
  );
  expect(app.texts().some((t) => t.includes("ssh-keygen -R changed.example"))).toBe(true);
  // No countdown: nothing will happen until the person fixes the key and presses Retry.
  expect(app.texts().some((t) => t.includes("reconnecting in"))).toBe(false);
  expect(app.shows("label:Retry Vault")).toBe(true);
  await app.press("label:Retry Vault");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Needs attention:")));
  expect(app.texts().some((t) => t.includes("reconnecting in"))).toBe(false);
});

test("a host that is not trusted yet says to run ssh once in a terminal, and is not retried", async () => {
  const app = await inMachines();
  await app.press("Script ssh failures");
  await addMachine(app, "Newbox", "unknown.example");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Needs attention:")));
  expect(app.texts().some((t) => t.includes("run `ssh unknown.example` once in a terminal to trust the host"))).toBe(
    true,
  );
  expect(app.texts().some((t) => t.includes("reconnecting in"))).toBe(false);
});

test("a refused connection is retried: the row says why and counts down to the next attempt", async () => {
  const app = await inMachines();
  await app.press("Script ssh failures");
  await addMachine(app, "Flaky", "refused.example");
  await app.waitUntil(() =>
    app
      .texts()
      .some((t) => t.startsWith("Not connected: ssh: connect to host refused.example port 22: Connection refused")),
  );
  expect(app.texts().some((t) => /reconnecting in \d+ s$/.test(t))).toBe(true);
  expect(app.texts().some((t) => t.startsWith("Needs attention"))).toBe(false);
  // A fault in one machine leaves this computer alone.
  expect(app.shows("Connected · herdr 0.9.5")).toBe(true);
});
