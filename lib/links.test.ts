import { expect, test } from "nsh/test";

import { chatMarkdown, MENTION, pathLink } from "#lib/links";

test("a path link's line comes from `:12`, `:12:3` or `#L12`", () => {
  expect(pathLink("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12, col: undefined });
  expect(pathLink("src/a.ts:12:3")).toEqual({ path: "src/a.ts", line: 12, col: 3 });
  expect(pathLink("src/a.ts#L12-L20")).toEqual({ path: "src/a.ts", line: 12 });
  expect(pathLink("src/a.ts")).toEqual({ path: "src/a.ts" });
});

test("links keep their whole text and are named by their address; a title the author wrote stays", () => {
  const url = "https://github.com/acme/x/releases/tag/v0.1.0-alpha.8";
  expect(chatMarkdown(`see ${url}.`)).toBe(`see [${url}](<${url}> "${url}").`);
  expect(chatMarkdown("<https://example.com/a>")).toBe(
    `[https://example.com/a](<https://example.com/a> "https://example.com/a")`,
  );
  expect(chatMarkdown("[the pull request](https://example.com/a)")).toBe(
    `[the pull request](<https://example.com/a> "https://example.com/a")`,
  );
  expect(chatMarkdown("[src/auth/login.ts:42](src/auth/login.ts:42)")).toBe(
    `[src/auth/login.ts:42](<src/auth/login.ts:42> "src/auth/login.ts:42")`,
  );
  expect(chatMarkdown('[a](https://example.com/a "The A page")')).toBe('[a](https://example.com/a "The A page")');
  // a bare address ends where GitHub ends it
  expect(chatMarkdown("(see https://example.com/a)")).toBe(
    `(see [https://example.com/a](<https://example.com/a> "https://example.com/a"))`,
  );
});

test("code is left alone: inline code, a fence inside a list and an indented block", () => {
  expect(chatMarkdown("run `curl https://example.com/a`")).toBe("run `curl https://example.com/a`");
  const fenced = "- step\n  ```sh\n  curl https://example.com/a\n  ```";
  expect(chatMarkdown(fenced)).toBe(fenced);
  expect(chatMarkdown("text\n\n    https://example.com/a")).toBe("text\n\n    https://example.com/a");
});

test("a picture the agent names by path gets a thumbnail under its paragraph, once, and never inside a list", () => {
  expect(chatMarkdown("The screen is `.scratch/after.png` now.\nNext line.")).toBe(
    `The screen is \`.scratch/after.png\` now.\nNext line.\n\n![after.png](<.scratch/after.png> "${MENTION}")`,
  );
  expect(chatMarkdown("See [after](./after.png).")).toContain(`![after.png](<./after.png> "${MENTION}")`);
  // already shown as an image: not repeated
  expect(chatMarkdown("![a](a.png) and `a.png`")).toBe("![a](a.png) and `a.png`");
  // a web picture and a list item are left alone
  expect(chatMarkdown("`https://example.com/a.png`")).not.toContain(MENTION);
  expect(chatMarkdown("- the shot is `a.png`")).not.toContain(MENTION);
});
