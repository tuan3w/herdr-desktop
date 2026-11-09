import { expect, test } from "nsh/test";

import type { PartView } from "herdr-desktop/native";

import { filesLabel, messageFiles } from "#lib/message-files";

const part = (over: Partial<PartView>): PartView => ({ partKind: "file", name: "x", ...over }) as PartView;

test("a picture a terminal chat sent as @path leaves the words and becomes the message's picture", () => {
  const m = messageFiles("not well align. @.herdr-desktop/attachments/image-4.png", []);
  expect(m.text).toBe("not well align.");
  expect(m.files).toEqual([
    { path: ".herdr-desktop/attachments/image-4.png", name: "image-4.png", picture: true, folder: false },
  ]);
  expect(filesLabel(m.files)).toBe("Picture image-4.png");
});

test("the trailing run of files goes, a quoted name and a folder too; words and addresses stay", () => {
  const m = messageFiles('it creates big gaps @shot.png @/tmp/log.txt @"my notes.md" @src/', []);
  expect(m.text).toBe("it creates big gaps");
  expect(m.files.map((f) => [f.name, f.picture, f.folder])).toEqual([
    ["shot.png", true, false],
    ["log.txt", false, false],
    ["my notes.md", false, false],
    ["src/", false, true],
  ]);
  expect(filesLabel(m.files)).toBe("Picture shot.png, File log.txt, File my notes.md, Folder src/");
  // `@claude` is a word, `me@host.io` an address: neither is a file.
  expect(messageFiles("ask @claude, mail me@host.io", [])).toEqual({
    text: "ask @claude, mail me@host.io",
    files: [],
    rest: [],
  });
});

test("a file named inside a sentence stays as its name, so the sentence still reads", () => {
  const m = messageFiles("compare @a.png with @b.png.", []);
  expect(m.text).toBe("compare a.png with b.png.");
  expect(m.files.map((f) => f.name)).toEqual(["a.png", "b.png"]);
});

test("a keeper's echo lines of its own attachments go: the parts are the files, each once", () => {
  const parts = [
    part({ partKind: "image", name: "shot.png", uri: "file:///w/app/shot.png" }),
    part({ partKind: "file", name: "src/a.rs", uri: "file:///w/app/src/a.rs" }),
    part({ partKind: "image", name: "image", data: "AAAA" }),
  ];
  const m = messageFiles("look at these\n[Image #1] shot.png\n@src/a.rs", parts);
  expect(m.text).toBe("look at these");
  expect(m.files.map((f) => [f.path, f.picture])).toEqual([
    ["/w/app/shot.png", true],
    ["/w/app/src/a.rs", false],
  ]);
  // A picture carried as bytes is still the bubble's own picture.
  expect(m.rest).toEqual([parts[2]]);
});
