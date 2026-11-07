import { expect, test } from "nsh/test";

import type { SessionItem } from "herdr-desktop/native";

import { lastCode, lastReply } from "#lib/session-copy";
import type { Row } from "#lib/session-rows";

const item = (id: number, text: string): SessionItem => ({
  id,
  rev: 1,
  kind: "message",
  role: "agent",
  text,
  images: [],
  parts: [],
});
const agent = (id: number, text: string): Row => ({
  kind: "agent",
  key: `i:${id}`,
  sig: String(id),
  item: item(id, text),
  live: false,
});
const user = (id: number): Row => ({ kind: "user", key: `i:${id}`, sig: String(id), item: item(id, "hi") });

test("the last reply is the newest agent message, whatever the person said after it", () => {
  expect(lastReply([agent(1, "first"), user(2), agent(3, "second"), user(4)])).toBe("second");
  expect(lastReply([user(1)])).toBeUndefined();
});

test("the last code is the last fence of the reply, exactly as written", () => {
  expect(lastCode("Try:\n\n```sh\nls -la\n```\n\nThen:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n")).toBe(
    "const a = 1;\n\nconst b = 2;",
  );
  expect(lastCode("No code, only `inline`.")).toBeUndefined();
  expect(lastCode(undefined)).toBeUndefined();
});
