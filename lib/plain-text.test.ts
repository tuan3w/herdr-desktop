import { expect, test } from "nsh/test";

import { plainText } from "#lib/plain-text";

test("a message copies as the words that were drawn, not the marks that drew them", () => {
  expect(plainText("## Result\n\nThe **loop** came from `login`, see [the docs](https://x.dev/a) and _this_.")).toBe(
    "Result\n\nThe loop came from login, see the docs (https://x.dev/a) and this.",
  );
});

test("code stays exactly as written, tabs and indentation included", () => {
  const code = "if x {\n\treturn 1\n}\n  trailing   ";
  expect(plainText(`Run:\n\n\`\`\`go\n${code}\n\`\`\`\n\nDone.`)).toBe(`Run:\n\n${code}\n\nDone.`);
});

test("a table becomes tab-separated rows and lists keep their markers", () => {
  expect(plainText("| Check | Result |\n| --- | --- |\n| unit | 42 passed |\n\n1. one\n2. two\n- a")).toBe(
    "Check\tResult\nunit\t42 passed\n\n1. one\n2. two\n- a",
  );
});

test("a link whose text is its address says it once, an image is its alt text, snake_case stays", () => {
  expect(plainText("[https://a.dev](https://a.dev) ![the chart](c.png) my_var_name and 2*3*4")).toBe(
    "https://a.dev the chart my_var_name and 2*3*4",
  );
});
