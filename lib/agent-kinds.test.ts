import { expect, test } from "nsh/test";
import schema from "../docs/herdr-api.schema.json";
import { AGENT_KINDS, folderError } from "./agent-kinds";

/** The `enum` in herdr's schema that lists `claude`: its agent kinds. */
function schemaKinds(node: unknown): string[] | undefined {
  if (Array.isArray(node)) return node.every((x) => typeof x === "string") && node.includes("claude") ? (node as string[]) : node.map(schemaKinds).find(Boolean);
  if (node && typeof node === "object") return Object.values(node).map(schemaKinds).find(Boolean);
  return undefined;
}

test("every agent offered is one herdr starts, and every kind herdr starts is offered once", () => {
  const herdr = schemaKinds(schema);
  expect(herdr).toBeDefined();
  const offered = AGENT_KINDS.map((k) => k.kind);
  expect([...offered].sort()).toEqual([...(herdr as string[])].sort());
  expect(new Set(offered).size).toBe(offered.length);
  expect(AGENT_KINDS.every((k) => k.title.trim() !== "")).toBe(true);
});

test("a folder is an absolute path on one line", () => {
  for (const ok of ["/", "/home/dev/payments-api", "  /srv/app  "]) expect(folderError(ok)).toBeUndefined();
  for (const bad of ["", "   ", "payments-api", "./x", "~/x", "/a\nb", "/a\0b"]) expect(folderError(bad)).toBeDefined();
});
