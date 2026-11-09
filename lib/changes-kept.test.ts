import { expect, test } from "nsh/test";

import type { ChangeView, StatusView } from "herdr-desktop/native";

import { keptStatus, wantedKey } from "#lib/changes-kept";

const status = { root: "/work/app", files: [] } as unknown as StatusView;
const change = { path: "src/a.ts", fingerprint: "fp-1" } as ChangeView;
const MINUTE = 60_000;

test("a status kept from the last visit is shown for ten minutes and not after", () => {
  const saved = { status, statusAt: 1_000_000 };
  expect(keptStatus(saved, 1_000_000 + 9 * MINUTE)).toBe(status);
  expect(keptStatus(saved, 1_000_000 + 10 * MINUTE)).toBe(status);
  expect(keptStatus(saved, 1_000_000 + 10 * MINUTE + 1)).toBeNull();
});

test("a tab that kept nothing starts empty", () => {
  expect(keptStatus({}, 5)).toBeNull();
  expect(keptStatus({ status }, 5)).toBeNull();
});

test("a kept diff is wanted again only for the same file, change and way of asking", () => {
  const same = wantedKey(change, 3, false, false);
  expect(wantedKey({ ...change } as ChangeView, 3, false, false)).toBe(same);
  expect(wantedKey({ ...change, fingerprint: "fp-2" } as ChangeView, 3, false, false)).not.toBe(same);
  expect(wantedKey(change, 12, false, false)).not.toBe(same);
  expect(wantedKey(change, 3, true, false)).not.toBe(same);
  expect(wantedKey(change, 3, false, true)).not.toBe(same);
  expect(wantedKey({ ...change, path: "src/b.ts" } as ChangeView, 3, false, false)).not.toBe(same);
  expect(wantedKey(undefined, 3, false, false)).toBe("");
});
