import { expect, test } from "nsh/test";

import { changedUnder, relativeIn } from "#lib/mention";

// git and the file system name `/var/x` as `/private/var/x`; a remote machine's paths are never rewritten.
const real = (machine: string, path: string) =>
  machine === "local" ? path.replace(/^\/var\//, "/private/var/") : path;

test("a file below the project is found through a link to the project, on this computer only", () => {
  expect(relativeIn("local", "/private/var/x/", "/var/x/src/a.ts", real)).toBe("src/a.ts");
  expect(relativeIn("local", "/var/x", "/private/var/x/src/", real)).toBe("src");
  expect(relativeIn("local", "/var/x", "/var/x-2/a.ts", real)).toBeNull();
  expect(relativeIn("local", "/var/x", "/var/x", real)).toBeNull();
  expect(relativeIn("ssh", "/private/var/x", "/var/x/a.ts", real)).toBeNull();
  expect(relativeIn("ssh", "/var/x/", "/var/x/a.ts", real)).toBe("a.ts");
});

test("git's changed files are listed relative to a project named by a link", () => {
  const files = ["src/a.ts", "b.ts"];
  expect(changedUnder("local", "/var/x/", "/private/var/x", files, real)).toEqual(["src/a.ts", "b.ts"]);
  expect(changedUnder("local", "/var/x/src", "/private/var/x", files, real)).toEqual(["a.ts"]);
  expect(changedUnder("ssh", "/var/x", "/private/var/x", files, real)).toEqual([]);
});
