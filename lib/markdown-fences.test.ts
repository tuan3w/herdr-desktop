import { expect, test } from "nsh/test";

import { fenceLanguage, splitFences, streamTail } from "#lib/markdown-fences";
import type { FenceSegment } from "#lib/markdown-fences";

const fences = (source: string) => splitFences(source).filter((s): s is FenceSegment => s.kind === "fence");

test("a fence between paragraphs is its own part, with its language and exact code", () => {
  const parts = splitFences("Here:\n\n```ts\nconst a = 1;\n\n  indented\n```\n\nDone.");
  expect(parts.map((p) => p.kind)).toEqual(["prose", "fence", "prose"]);
  const fence = parts[1] as FenceSegment;
  expect(fence.info).toBe("ts");
  expect(fence.code).toBe("const a = 1;\n\n  indented");
  expect(fence.open).toBe(false);
});

test("a fence still being written is the open last part, and its info is only complete after the line break", () => {
  const typing = fences("Look\n```ru")[0]!;
  expect(typing.open).toBe(true);
  expect(typing.infoComplete).toBe(false);
  const writing = fences("Look\n```rust\nfn main() {\n    prin")[0]!;
  expect(writing.open).toBe(true);
  expect(writing.infoComplete).toBe(true);
  expect(writing.code).toBe("fn main() {\n    prin");
});

test("a longer fence holds shorter ones and ~~~ fences work; a closer must be as long as the opener", () => {
  const four = fences("````md\n```ts\nx\n```\n````")[0]!;
  expect(four.code).toBe("```ts\nx\n```");
  expect(four.open).toBe(false);
  expect(fences("~~~sh\nls\n~~~")[0]!.code).toBe("ls");
  expect(fences("```\na\n``` \nb\n```")[0]!.code).toBe("a");
});

test("a fence inside a list item or a quote stays in the prose, where the text view draws it", () => {
  expect(splitFences("- step\n  ```sh\n  ls\n  ```\n- next").map((p) => p.kind)).toEqual(["prose"]);
  expect(splitFences("> ```sh\n> ls\n> ```").map((p) => p.kind)).toEqual(["prose"]);
  // A fence of its own after the list is top-level again.
  expect(splitFences("1. one\n2. two\n\n```sh\nls\n```").map((p) => p.kind)).toEqual(["prose", "fence"]);
});

test("the fence's indentation is not part of its code, and an indented block of four spaces is not a fence", () => {
  expect(fences("  ```py\n  a = 1\n    b = 2\n  ```")[0]!.code).toBe("a = 1\n  b = 2");
  expect(fences("    ```py\n    x\n    ```")).toHaveLength(0);
});

test("a backtick fence's info cannot hold a backtick, so inline code on a line of its own is prose", () => {
  expect(fences("```not a `fence`")).toHaveLength(0);
});

test("a title attribute of the info string names the block, and the language is its first word", () => {
  const fence = fences('```ts title="src/a.ts"\nx\n```')[0]!;
  expect(fence.title).toBe("src/a.ts");
  expect(fenceLanguage(fence.info)).toBe("ts");
  expect(fenceLanguage("{.python .numberLines}")).toBe("python");
  expect(fenceLanguage("language-Go")).toBe("go");
  expect(fenceLanguage("rust,no_run")).toBe("rust");
});

test("keys stay the same while a message grows, so each block keeps its view", () => {
  const short = splitFences("Intro\n\n```ts\nconst a");
  const longer = splitFences("Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nThen more.");
  expect(short.map((p) => p.key)).toEqual(["p:0", "f:1"]);
  expect(longer.map((p) => p.key).slice(0, 2)).toEqual(["p:0", "f:1"]);
});

test("a text without a fence is one prose part, and an empty text has none", () => {
  expect(splitFences("Just **words**.\n\nTwo paragraphs.")).toHaveLength(1);
  expect(splitFences("")).toHaveLength(0);
});

test("a fence being written keeps its last lines, says how many came before, and a short one is whole", () => {
  expect(streamTail("a\nb\nc\nd\ne", 2)).toEqual({ code: "d\ne", skipped: 3 });
  expect(streamTail("a\nb", 2)).toEqual({ code: "a\nb", skipped: 0 });
  expect(streamTail("a\nb\nc\n", 2)).toEqual({ code: "c\n", skipped: 2 });
  expect(streamTail("", 3)).toEqual({ code: "", skipped: 0 });
});
