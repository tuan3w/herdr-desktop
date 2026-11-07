import { expect, test } from "nsh/test";
import { destinationError, fieldOfRejection, portError, sessionError } from "./machine-rules";

test("a destination is a host, user@host, an address or an ssh alias, and anything that ssh or a shell would read otherwise is refused", () => {
  for (const ok of ["devbox", "me@devbox.example.com", "10.0.0.5", "[fe80::1]", "git-box_2", "u@h:22"]) expect(destinationError(ok)).toBeUndefined();
  const refused = [
    "",
    "-oProxyCommand=touch/tmp/x",
    "-",
    "two words",
    "a;b",
    "a&&b",
    "a|b",
    "`id`",
    "$(id)",
    "a'b",
    'a"b',
    "a\nb",
    "a\\b",
    "a>b",
    "host\u00e9",
    "x".repeat(256),
  ];
  for (const bad of refused) expect(destinationError(bad)).toBeDefined();
  expect(destinationError("x".repeat(255))).toBeUndefined();
});

test("a session name is a safe file name, empty meaning herdr's own, and . and .. are not names", () => {
  for (const ok of ["", "work", "a.b_c-1"]) expect(sessionError(ok)).toBeUndefined();
  for (const bad of [".", "..", "a b", "a/b", "a;b", "$HOME"]) expect(sessionError(bad)).toBeDefined();
});

test("a port is a whole number from 1 to 65535, or none", () => {
  for (const ok of [null, 1, 22, 65535]) expect(portError(ok)).toBeUndefined();
  for (const bad of [0, -1, 65536, 22.5, Number.NaN]) expect(portError(bad)).toBeDefined();
});

test("a rejection from the engine is matched to the field it is about, and anything else is about the whole save", () => {
  expect(fieldOfRejection("invalid destination: must not start with '-'")).toBe("destination");
  expect(fieldOfRejection("invalid session: may only contain letters, digits and . _ -")).toBe("session");
  expect(fieldOfRejection("invalid port: must be 1 to 65535")).toBe("port");
  expect(fieldOfRejection("Give the machine a name")).toBe("name");
  expect(fieldOfRejection("There is no machine m7")).toBeUndefined();
});
