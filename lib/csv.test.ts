import { expect, test } from "nsh/test";

import { detectDelimiter, parseSheet, ROW_LIMIT } from "#lib/csv";

test("a quoted cell keeps its separator, its line break and a doubled quote", () => {
  const sheet = parseSheet('name,note\n"Lin, Ada","said ""hi""\nthen left"\nSam,plain\n');
  expect(sheet.header).toEqual(["name", "note"]);
  expect(sheet.rows).toEqual([
    ["Lin, Ada", 'said "hi"\nthen left'],
    ["Sam", "plain"],
  ]);
});

test("the separator is the one that splits the first lines evenly: comma, semicolon, tab or bar", () => {
  expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
  expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
  expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
  expect(detectDelimiter("one column only\nanother\n")).toBe(",");
  expect(detectDelimiter("price,item\n1,5;6\n")).toBe(",");
});

test("a first row of numbers is data, not a header; repeated and empty headers stay distinct", () => {
  const data = parseSheet("1,2\n3,4\n");
  expect(data.header).toEqual(["column 1", "column 2"]);
  expect(data.rows).toHaveLength(2);
  expect(parseSheet("a,a,\n1,2,3\n").header).toEqual(["a", "a (2)", "column 3"]);
});

test("short rows are padded, CRLF and a byte order mark are handled, and blank lines are skipped", () => {
  const sheet = parseSheet("\uFEFFa,b,c\r\n1,2\r\n\r\n4,5,6\r\n");
  expect(sheet.header).toEqual(["a", "b", "c"]);
  expect(sheet.rows).toEqual([
    ["1", "2", ""],
    ["4", "5", "6"],
  ]);
});

test("more rows than the limit are cut and said, not dropped silently", () => {
  const text = `n,v\n${Array.from({ length: ROW_LIMIT + 50 }, (_, i) => `${i},x`).join("\n")}\n`;
  const sheet = parseSheet(text);
  expect(sheet.rows).toHaveLength(ROW_LIMIT);
  expect(sheet.truncated).toBe(true);
  expect(parseSheet("a,b\n1,2\n").truncated).toBe(false);
});

test("empty text is an empty table", () => {
  const sheet = parseSheet("");
  expect(sheet.header).toEqual([]);
  expect(sheet.rows).toEqual([]);
});
