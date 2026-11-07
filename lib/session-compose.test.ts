import { expect, test } from "nsh/test";

import { deliveryNote, restoreText } from "#lib/session-compose";

test("the box says what a send will do, and a message taken back loses nothing typed", () => {
  expect(deliveryNote({ running: true, queue: [] })).toMatch(/queue/);
  expect(deliveryNote({ running: false, queue: [] })).toBeNull();
  expect(restoreText("", "first")).toBe("first");
  expect(restoreText("draft", "first")).toBe("first\ndraft");
});
