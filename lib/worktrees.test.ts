import { describe, expect, test } from "nsh/test";

import { branchError, MAX_BRANCH_BYTES, suggestBranch } from "#lib/worktrees";

/** The same names as `native/core/tests/worktree.rs`: what one side rejects the other rejects, minus what the form trims. */
const REJECTED = [
  "a;touch x",
  "$(x)",
  "`id`",
  "a|b",
  "a&b",
  "a>b",
  'a"b',
  "a'b",
  "--force",
  "-b",
  "a b",
  "a\nb",
  "a\rb",
  "a\tb",
  "a\0b",
  "a\u007fb",
  "feature/é",
  "ブランチ",
  "a‮b",
  "a..b",
  "..",
  "a@{1}",
  "@",
  "a~1",
  "a^",
  "a:b",
  "a?b",
  "a*b",
  "a[b",
  "a\\b",
  "x.lock",
  "feature.lock/x",
  "/a",
  "a/",
  "a//b",
  "a.",
  ".hidden",
  "a/.hidden",
  "a".repeat(MAX_BRANCH_BYTES + 1),
];
const ACCEPTED = [
  "feature/x",
  "worktree/brave-meadow-45e8",
  "fix_1.2",
  "release-1.0.0",
  "a",
  "user/jane/topic+1",
  "a".repeat(MAX_BRANCH_BYTES),
];

describe("branchError", () => {
  test("every unsafe or malformed name is refused with a reason", () => {
    for (const name of REJECTED) expect([name, typeof branchError(name)]).toEqual([name, "string"]);
  });
  test("ordinary names are accepted", () => {
    for (const name of ACCEPTED) expect([name, branchError(name)]).toEqual([name, undefined]);
  });
  test("an empty name is fine (herdr names the branch), spaces around a name are the field's to trim", () => {
    expect(branchError("")).toBeUndefined();
    expect(branchError("   ")).toBeUndefined();
    expect(branchError("  feature/x  ")).toBeUndefined();
  });
  test("the cap counts bytes, not letters", () => {
    expect(typeof branchError("é".repeat(MAX_BRANCH_BYTES))).toBe("string");
  });
});

describe("suggestBranch", () => {
  test("has herdr's shape", () => {
    expect(suggestBranch([])).toMatch(/^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    expect(branchError(suggestBranch([]))).toBeUndefined();
  });
  test("is never a branch a checkout already has", () => {
    // A generator that repeats itself once, then moves on: the taken name must be skipped.
    const rolls = [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
    const random = () => rolls.shift() ?? 0.9;
    const first = suggestBranch([], () => 0);
    expect(first).toBe("worktree/brave-meadow-0000");
    expect(suggestBranch([first], random)).not.toBe(first);
  });
});
