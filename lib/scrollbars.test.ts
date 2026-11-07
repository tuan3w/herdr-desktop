import { expect, test } from "nsh/test";

import { scrollbarTheme } from "#lib/scrollbars";

test("the bar shows while the view scrolls, and Always show scrollbars keeps it on screen with a firmer thumb", () => {
  const transient = scrollbarTheme();
  const always = scrollbarTheme(true);
  expect(transient.mode).toBe("scrolling");
  expect(always.mode).toBe("always");
  // A resting bar that has to be found is held to 3:1 (`design/scroll.md`); the one that only follows a scroll is lighter.
  expect(transient.vertical?.thumbClass).toContain("bg-muted-foreground/65");
  expect(always.vertical?.thumbClass).toContain("bg-muted-foreground/85");
  expect(always.horizontal?.thumbClass).toContain("bg-muted-foreground/85");
  // Under the pointer both are the full token, so reaching for the thumb never meets a faint one.
  expect(transient.vertical?.thumbClass).toContain("hover:bg-muted-foreground");
  expect(transient.vertical?.thumbClass).toContain("active:bg-muted-foreground");
});
