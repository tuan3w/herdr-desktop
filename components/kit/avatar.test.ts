import { expect, test } from "nsh/test";

import { fallbackShown, initials } from "./avatar";

test("the fallback draws at most two letters, upper case, and a mark when there is none", () => {
  expect(initials("tn")).toBe("TN");
  expect(initials("WWW")).toBe("WW");
  expect(initials("")).toBe("?");
  expect(initials("   ")).toBe("?");
  expect(initials("日本語")).toBe("日本");
  expect(initials("👩‍💻x")).toBe("👩‍💻X");
  expect(initials("عل")).toBe("عل");
});

test("the initials wait for the delay and leave once the picture has loaded", () => {
  expect(fallbackShown("loading", false)).toBe(false);
  expect(fallbackShown("loading", true)).toBe(true);
  expect(fallbackShown("loaded", true)).toBe(false);
  expect(fallbackShown("error", true)).toBe(true);
});
