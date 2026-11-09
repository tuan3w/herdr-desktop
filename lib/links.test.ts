import { expect, test } from "nsh/test";

import { chatMarkdown, MARK, MENTION, pathLink, shortUrl } from "#lib/links";

test("a web address is drawn as its host and its path; a long path keeps its last two segments", () => {
  expect(shortUrl("https://github.com/acme/payments-api/pull/128")).toEqual({
    host: "github.com",
    rest: "/acme/payments-api/pull/128",
  });
  expect(shortUrl("https://docs.example.com/guides/payments/webhooks/retries/backoff/settings")).toEqual({
    host: "docs.example.com",
    rest: "/…/backoff/settings",
  });
  expect(shortUrl("http://localhost:5173/")).toEqual({ host: "localhost:5173", rest: "" });
  // a short fragment stays (a line of a file on GitHub), a long one and a query are said to be there, not shown
  expect(shortUrl("https://github.com/a/b/blob/main.rs#L42")?.rest).toBe("/a/b/blob/main.rs#L42");
  expect(shortUrl("https://example.com/search?q=secret-token")?.rest).toBe("/search?…");
  // a user in the address would hide the real host behind a short form: shown whole
  expect(shortUrl("https://github.com@evil.example/x")).toBeNull();
});

test("a path link's line comes from `:12`, `:12:3` or `#L12`", () => {
  expect(pathLink("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12, col: undefined });
  expect(pathLink("src/a.ts:12:3")).toEqual({ path: "src/a.ts", line: 12, col: 3 });
  expect(pathLink("src/a.ts#L12-L20")).toEqual({ path: "src/a.ts", line: 12 });
  expect(pathLink("src/a.ts")).toEqual({ path: "src/a.ts" });
});

test("only a link whose text is its own address is drawn short; the address stays its target and title", () => {
  const bare = chatMarkdown("see https://github.com/acme/x/pull/1.");
  expect(bare).toBe(
    `see [![https://github.com/acme/x/pull/1](${MARK}web)github.com<small> /acme/x/pull/1</small>](<https://github.com/acme/x/pull/1> "https://github.com/acme/x/pull/1").`,
  );
  expect(chatMarkdown("<https://example.com/a>")).toContain(`(<https://example.com/a> "https://example.com/a")`);
  expect(chatMarkdown("[https://example.com/a](https://example.com/a)")).toContain("example.com<small> /a</small>");
  // a label the author wrote is theirs
  expect(chatMarkdown("[the pull request](https://example.com/a)")).toBe("[the pull request](https://example.com/a)");
  // a file link named by its own path shows its name and line
  expect(chatMarkdown("[src/auth/login.ts:42](src/auth/login.ts:42)")).toContain(
    `${MARK}file)login.ts<small>:42</small>](<src/auth/login.ts:42>`,
  );
});

test("code is never rewritten: inline code, a fence inside a list and an indented block keep their addresses", () => {
  expect(chatMarkdown("run `curl https://example.com/a`")).toBe("run `curl https://example.com/a`");
  const fenced = "- step\n  ```sh\n  curl https://example.com/a\n  ```";
  expect(chatMarkdown(fenced)).toBe(fenced);
  expect(chatMarkdown("text\n\n    https://example.com/a")).toBe("text\n\n    https://example.com/a");
});

test("a bare address ends where GitHub ends it: trailing punctuation and an unbalanced bracket are not part of it", () => {
  expect(chatMarkdown("(see https://example.com/a)")).toMatch(
    /<https:\/\/example\.com\/a> "https:\/\/example\.com\/a"\)\)$/,
  );
  expect(chatMarkdown("https://en.wikipedia.org/wiki/Foo_(bar)")).toContain(
    "<https://en.wikipedia.org/wiki/Foo_(bar)>",
  );
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
