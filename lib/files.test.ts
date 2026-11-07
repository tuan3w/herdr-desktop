import { expect, test } from "nsh/test";

import type { EntryView } from "herdr-desktop/native";

import {
  arrange,
  crumbs,
  entryLabel,
  joinPath,
  modifiedText,
  parentOf,
  placeText,
  routeLink,
  sizeText,
  stepNames,
  stepOf,
} from "#lib/files";

const entry = (name: string, patch: Partial<EntryView> = {}): EntryView => ({
  name,
  kind: "file",
  size: 0,
  readable: true,
  link: false,
  ...patch,
});

test("a link goes where it belongs: files to the viewer, a remote machine's localhost to a page, the rest to the browser", () => {
  const remote = { local: false, loopback: false };
  expect(routeLink("path", "src/main.rs", remote)).toBe("file");
  expect(routeLink("url", "https://example.com/x", remote)).toBe("browser");
  expect(routeLink("url", "http://localhost:5173/", { local: false, loopback: true })).toBe("page");
  // this computer's own localhost is the browser's: there is nothing to tunnel
  expect(routeLink("url", "http://localhost:5173/", { local: true, loopback: true })).toBe("browser");
  // an address that is not http or https is never opened, only copied
  expect(routeLink("url", "javascript:alert(1)", remote)).toBe("address");
  expect(routeLink("url", "file:///etc/passwd", remote)).toBe("address");
});

test("a folder lists folders first, then by the order asked, and hides dotfiles unless asked", () => {
  const entries = [
    entry("app", { kind: "dir", modified: 10 }),
    entry("big.log", { size: 5000, modified: 20 }),
    entry(".env", { size: 10, modified: 30 }),
    entry("notes.txt", { size: 100, modified: 40 }),
    entry("zeta", { kind: "dir", modified: 50 }),
  ];
  const names = (sort: "name" | "modified" | "size", hidden = false) =>
    arrange(entries, { sort, hidden }).map((e) => e.name);
  expect(names("name")).toEqual(["app", "big.log", "notes.txt", "zeta"]);
  expect(names("name", true)).toContain(".env");
  expect(names("modified")).toEqual(["zeta", "app", "notes.txt", "big.log"]);
  expect(names("size")).toEqual(["app", "zeta", "big.log", "notes.txt"]);
  expect(names("size", true)).toEqual(["app", "zeta", "big.log", "notes.txt", ".env"]);
});

test("a path is cut into the folders that lead to it, and a file's folder is the one above", () => {
  expect(crumbs("/home/dev/app")).toEqual([
    { name: "/", path: "/" },
    { name: "home", path: "/home" },
    { name: "dev", path: "/home/dev" },
    { name: "app", path: "/home/dev/app" },
  ]);
  expect(crumbs("/")).toEqual([{ name: "/", path: "/" }]);
  expect(parentOf("/home/dev/app")).toBe("/home/dev");
  expect(parentOf("/home")).toBe("/");
  expect(parentOf("/")).toBeNull();
  expect(joinPath("/a/b/", "c.txt")).toBe("/a/b/c.txt");
  expect(joinPath("/", "c.txt")).toBe("/c.txt");
});

test("sizes and times read the way a person says them", () => {
  expect(sizeText(1)).toBe("1 byte");
  expect(sizeText(512)).toBe("512 bytes");
  expect(sizeText(2048)).toBe("2 KB");
  expect(sizeText(1.5 * 1024 * 1024)).toBe("1.5 MB");
  expect(sizeText(40 * 1024 * 1024)).toBe("40 MB");
  expect(sizeText(3 * 1024 ** 3)).toBe("3.0 GB");
  const now = 1_790_000_000;
  expect(modifiedText(now - 10, now)).toBe("just now");
  expect(modifiedText(now - 600, now)).toBe("10 min ago");
  expect(modifiedText(now - 3 * 86400, now)).toBe("3 d ago");
  expect(modifiedText(null, now)).toBe("");
  // beyond a month: the date, and the year only when it is not this one
  expect(modifiedText(now - 90 * 86400, now)).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
  expect(modifiedText(now - 800 * 86400, now)).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
});

test("a row says what it is, how big and when, and when nobody can open it", () => {
  const now = 1_790_000_000;
  expect(entryLabel(entry("a.txt", { size: 2048, modified: now - 600 }), now)).toBe("a.txt, file, 2 KB, 10 min ago");
  expect(entryLabel(entry("src", { kind: "dir" }), now)).toBe("src, folder");
  expect(entryLabel(entry("shortcut", { kind: "dir", link: true }), now)).toBe("shortcut, link, folder");
  expect(entryLabel(entry("secret", { readable: false }), now)).toContain("no permission");
});

test("the viewer steps through the pictures when it shows a picture, and through every file otherwise, folders left out", () => {
  const entries = [entry("a.txt"), entry("docs", { kind: "dir" }), entry("b.png"), entry("c.md"), entry("d.JPG")];
  expect(stepNames(entries, "b.png")).toEqual(["b.png", "d.JPG"]);
  expect(stepNames(entries, "c.md")).toEqual(["a.txt", "b.png", "c.md", "d.JPG"]);
  const pictures = stepNames(entries, "b.png");
  expect(stepOf(pictures, "b.png", 1)).toBe("d.JPG");
  expect(stepOf(pictures, "b.png", -1)).toBeNull();
  expect(stepOf(pictures, "gone.png", 1)).toBeNull();
  expect(placeText(pictures, "d.JPG", true)).toBe("Photo 2 of 2");
  expect(placeText(stepNames(entries, "c.md"), "c.md", false)).toBe("File 3 of 4");
  expect(placeText(pictures, "gone.png", true)).toBe("");
});
