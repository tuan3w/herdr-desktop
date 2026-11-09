import { expect, test } from "nsh/test";

import { addressParts, refusedNote, swapOrigin, webAddress } from "#lib/browser";

test("typed text without a scheme becomes https, and http only for this computer's own loopback", () => {
  expect(webAddress("github.com/acme/payments-api")).toEqual({ url: "https://github.com/acme/payments-api" });
  expect(webAddress("  docs.example.com  ")).toEqual({ url: "https://docs.example.com/" });
  expect(webAddress("localhost:5173/account")).toEqual({ url: "http://localhost:5173/account" });
  expect(webAddress("127.0.0.1:8080")).toEqual({ url: "http://127.0.0.1:8080/" });
  expect(webAddress("HTTPS://Example.com/A")).toEqual({ url: "https://example.com/A" });
  expect(webAddress("http://localhost:3000/")).toEqual({ url: "http://localhost:3000/" });
});

test("the address field refuses what the panel does not show, and never searches", () => {
  // Plain http to another computer travels unencrypted: the browser's, as for a pressed link.
  expect("error" in webAddress("http://example.com/")).toBe(true);
  expect("error" in webAddress("file:///etc/passwd")).toBe(true);
  expect("error" in webAddress("javascript:alert(1)")).toBe(true);
  expect("error" in webAddress("mailto:a@example.com")).toBe(true);
  // Words are not sent anywhere: no search engine learns what was typed.
  expect("error" in webAddress("how to fix login")).toBe(true);
  expect("error" in webAddress("payments")).toBe(true);
  expect("error" in webAddress("   ")).toBe(true);
});

test("at rest the host reads first; http keeps its scheme, and a user name in the address never poses as the host", () => {
  expect(addressParts("https://github.com/acme/pull/128?tab=files")).toEqual({
    lead: "",
    host: "github.com",
    rest: "/acme/pull/128?tab=files",
  });
  expect(addressParts("https://example.com/")).toEqual({ lead: "", host: "example.com", rest: "" });
  expect(addressParts("http://localhost:5173/a%20b")).toEqual({
    lead: "http://",
    host: "localhost:5173",
    rest: "/a b",
  });
  expect(addressParts("https://github.com@evil.example/x").host).toBe("evil.example");
  expect(addressParts("about:blank")).toEqual({ lead: "", host: "about:blank", rest: "" });
});

test("a tunnel's local origin swaps for the machine's, and nothing else does", () => {
  const local = "http://127.0.0.1:43123";
  const remote = "http://localhost:5173";
  expect(swapOrigin("http://127.0.0.1:43123/app?x=1", local, remote)).toBe("http://localhost:5173/app?x=1");
  expect(swapOrigin("http://127.0.0.1:43123", local, remote)).toBe(remote);
  // Another port that starts with the same digits is another page.
  expect(swapOrigin("http://127.0.0.1:431234/", local, remote)).toBe("http://127.0.0.1:431234/");
  expect(swapOrigin("https://github.com/", local, remote)).toBe("https://github.com/");
});

test("a refused link to another app says so; a page's own internals say nothing", () => {
  expect(refusedNote("mailto:a@example.com")).not.toBeNull();
  expect(refusedNote("file:///etc/hosts")).not.toBeNull();
  expect(refusedNote("data:text/html,hi")).toBeNull();
  expect(refusedNote("about:blank")).toBeNull();
  expect(refusedNote("")).toBeNull();
});
