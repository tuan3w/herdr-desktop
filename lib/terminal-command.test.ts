import { expect, test } from "nsh/test";

import { herdrClientCommand, shq, validDest, validSession } from "#lib/terminal-command";

const command = (r: ReturnType<typeof herdrClientCommand>): string => ("command" in r ? r.command : `WHY ${r.why}`);

test("this computer opens the herdr client, in the default session or a named one", () => {
  expect(command(herdrClientCommand({ local: true }))).toMatch(/ exec herdr$/);
  expect(command(herdrClientCommand({ local: true, session: "work" }))).toMatch(/ exec herdr --session 'work'$/);
});

test("a remote machine uses herdr --remote, and ssh with the destination after -- when it has a port", () => {
  expect(command(herdrClientCommand({ local: false, dest: "me@box" }))).toMatch(/ exec herdr --remote 'me@box'$/);
  expect(command(herdrClientCommand({ local: false, dest: "box", session: "s1" }))).toMatch(
    / exec herdr --remote 'box' --session 's1'$/,
  );
  expect(command(herdrClientCommand({ local: false, dest: "me@box", port: 2222, session: "s1" }))).toBe(
    `exec ssh -t -p 2222 -- 'me@box' 'herdr --session '\\''s1'\\'''`,
  );
});

const HOSTILE = [
  "$(touch x)",
  "`id`",
  "a\nb",
  "a; touch x",
  "-oProxyCommand=x",
  "a b",
  "a'b",
  "a|b",
  "a&b",
  "a>b",
  "",
  "a\0b",
];

test("a hostile destination is refused and never reaches a command line", () => {
  for (const dest of HOSTILE) {
    expect(validDest(dest)).toBe(false);
    for (const port of [null, 22]) expect(command(herdrClientCommand({ local: false, dest, port }))).toMatch(/^WHY /);
  }
  expect(validDest("a".repeat(256))).toBe(false);
});

test("a hostile session name is refused for this computer and for a remote one", () => {
  for (const session of [...HOSTILE.filter((s) => s !== ""), "", ".", ".."]) {
    expect(validSession(session)).toBe(false);
    expect(command(herdrClientCommand({ local: true, session }))).toMatch(/^WHY /);
    expect(command(herdrClientCommand({ local: false, dest: "box", session }))).toMatch(/^WHY /);
  }
});

test("a port that is not a port is refused", () => {
  for (const port of [0, -1, 70000, 22.5, Number.NaN])
    expect(command(herdrClientCommand({ local: false, dest: "box", port }))).toMatch(/^WHY /);
});

test("shq makes one word of anything, quotes included", () => {
  expect(shq("a b")).toBe("'a b'");
  expect(shq("it's")).toBe(`'it'\\''s'`);
  expect(shq("$(x)`y`\n;")).toBe("'$(x)`y`\n;'");
});
