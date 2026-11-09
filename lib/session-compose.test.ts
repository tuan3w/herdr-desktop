import { expect, test } from "nsh/test";

import { restoreText } from "#lib/session-compose";

test("a message taken back from the queue loses nothing typed", () => {
  expect(restoreText("", "first")).toBe("first");
  expect(restoreText("draft", "first")).toBe("first\ndraft");
});
