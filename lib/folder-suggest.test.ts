import { expect, test } from "nsh/test";

import { complete, isMissing, parents, suggest } from "#lib/folder-suggest";

const dir = (name: string, readable = true) => ({ name, kind: "dir", readable });
const file = (name: string) => ({ name, kind: "file", readable: true });
const names = (typed: string, entries: ReturnType<typeof dir>[], shown: string) =>
  suggest({ typed, listed: { shown, entries }, projects: [], recents: [] }).rows.map((r) => r.name);

test("the folders to ask run from the one typed up to the root, and a path that is not one asks nothing", () => {
  expect(parents("/home/me/pro")).toEqual([
    { shown: "/home/me/", dir: "/home/me" },
    { shown: "/home/", dir: "/home" },
    { shown: "/", dir: "/" },
  ]);
  expect(parents("~/co")).toEqual([{ shown: "~/", dir: "~" }]);
  expect(parents("/")).toEqual([{ shown: "/", dir: "/" }]);
  for (const nope of ["", "relative/path", "~", "~user/x", "/a\nb/", "/a\0b/", `/${"x".repeat(5000)}/`])
    expect(parents(nope)).toEqual([]);
});

test("the tail narrows the folders, a prefix before a substring, case and accents ignored, files never offered", () => {
  const entries = [dir("docs"), dir("my-app"), dir("Apple"), dir("Écran"), dir("zap"), file("app.txt")];
  expect(names("/w/ap", entries, "/w/")).toEqual(["Apple", "my-app", "zap"]);
  expect(names("/w/ecr", entries, "/w/")).toEqual(["Écran"]);
  expect(names("/w/", entries, "/w/")).toEqual(["docs", "my-app", "Apple", "Écran", "zap"]);
});

test("hidden folders show only once the tail starts with a dot", () => {
  const entries = [dir(".git"), dir(".config"), dir("src")];
  expect(names("/w/", entries, "/w/")).toEqual(["src"]);
  expect(names("/w/.", entries, "/w/")).toEqual([".git", ".config"]);
  expect(names("/w/.c", entries, "/w/")).toEqual([".config"]);
});

test("completing a folder appends a slash so the next level lists, spaces and unicode kept whole", () => {
  const { rows } = suggest({
    typed: "~/pro",
    listed: { shown: "~/", entries: [dir("projects"), dir("my docs"), dir("日本")] },
    projects: [],
    recents: [],
  });
  expect(rows.map(complete)).toEqual(["~/projects/"]);
  const spaced = suggest({
    typed: "/a/my d",
    listed: { shown: "/a/", entries: [dir("my docs")] },
    projects: [],
    recents: [],
  });
  expect(spaced.rows.map(complete)).toEqual(["/a/my docs/"]);
  const cjk = suggest({ typed: "/a/日", listed: { shown: "/a/", entries: [dir("日本")] }, projects: [], recents: [] });
  expect(cjk.rows.map(complete)).toEqual(["/a/日本/"]);
});

test("an unreadable folder is listed, says so and cannot be picked", () => {
  const { rows } = suggest({
    typed: "/w/",
    listed: { shown: "/w/", entries: [dir("secret", false), dir("open")] },
    projects: [],
    recents: [],
  });
  const secret = rows.find((r) => r.name === "secret");
  expect(secret?.unreadable).toBe(true);
  expect(secret?.hint).toBe("No permission");
  expect(rows.find((r) => r.name === "open")?.unreadable).toBeFalsy();
});

test("a tail that matches nothing is said once, with where it was looked for, and a deeper typed path names its first missing folder", () => {
  const entries = [dir("src")];
  expect(suggest({ typed: "/w/zzz", listed: { shown: "/w/", entries }, projects: [], recents: [] })).toEqual({
    rows: [],
    note: "No folder named zzz in /w/",
  });
  expect(suggest({ typed: "/w/zzz/deeper/x", listed: { shown: "/w/", entries }, projects: [], recents: [] }).note).toBe(
    "No folder named zzz in /w/",
  );
  expect(suggest({ typed: "/w/", listed: { shown: "/w/", entries: [] }, projects: [], recents: [] }).note).toBe(
    "No folders in /w/",
  );
});

test("hostile names and paths never crash and never reach a path: dots, slashes and control characters are not folders", () => {
  const entries = [dir("."), dir(".."), dir("a/b"), dir("line\nbreak"), dir("nul\0"), dir("ok")];
  expect(names("/w/", entries, "/w/")).toEqual(["ok"]);
  // `..` in what is typed is the machine's to resolve: it lists, it is never composed into a command.
  expect(parents("/w/../x/y")[0]).toEqual({ shown: "/w/../x/", dir: "/w/../x" });
  expect(
    suggest({ typed: "/w//", listed: { shown: "/w//", entries: [dir("ok")] }, projects: [], recents: [] }).rows.map(
      complete,
    ),
  ).toEqual(["/w//ok/"]);
  // a listing that does not belong to what is typed (the answer is late) offers nothing
  expect(suggest({ typed: "/other/x", listed: { shown: "/w/", entries }, projects: [], recents: [] })).toEqual({
    rows: [],
  });
});

test("an empty field offers the projects, then the recent folders that are not projects, each named by its last two parts", () => {
  const { rows } = suggest({
    typed: "",
    listed: undefined,
    projects: ["/home/me/work/api", "/home/me/web"],
    recents: ["/home/me/web/", "/tmp/scratch", "/"],
  });
  expect(rows.map((r) => [r.group, r.name, r.hint])).toEqual([
    ["Projects", "api", "work"],
    ["Projects", "web", "me"],
    ["Recent", "scratch", "tmp"],
    ["Recent", "/", undefined],
  ]);
  // choosing one fills the field with the folder as it is: no slash added
  expect(rows.map(complete)).toEqual(["/home/me/work/api", "/home/me/web", "/tmp/scratch", "/"]);
});

test("nothing is offered for text that is not a path, and a blank field with nothing known offers nothing", () => {
  expect(suggest({ typed: "relative", listed: undefined, projects: ["/a"], recents: [] })).toEqual({ rows: [] });
  expect(suggest({ typed: "  ", listed: undefined, projects: [], recents: [] })).toEqual({ rows: [] });
});

test("only a folder that is not there is walked past; a refusal or an unreachable machine is a failure to show", () => {
  expect(isMissing("/w/x does not exist")).toBe(true);
  expect(isMissing("/w/file.txt is not a folder")).toBe(true);
  expect(isMissing("Permission denied: /w/x")).toBe(false);
  expect(isMissing("ssh: connect to host build-box port 22: Connection timed out")).toBe(false);
});
