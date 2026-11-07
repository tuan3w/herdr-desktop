// Project imports are absolute: `import { keyLabel } from "#lib/shortcuts"`, `import { agentTitle } from "#components/composer"`,
// `import { Btn } from "#kit"`; never `"../lib/shortcuts"` or `"./composer"`. The aliases are `package.json` `imports`
// (Node's subpath imports): the bundler and the type checker both read them from the importing file's own package, which
// is why a lab entry under `components/` resolves them too (nsh's `resolve.alias` and tsconfig `paths` follow the entry's
// directory instead, and `nsh test` fails on a `@/` import in a lab).
// Not rewritten: siblings inside `components/kit/` (one closed module, imported only through `#kit`), assets (fonts, SVG,
// images: nsh resolves them from the importing file), and `.ts` files in `components/` (test seams, imported by the tests
// next to them): `imports` targets are exact, so a `.ts`/`.tsx` pair cannot share one pattern.
//
//   node scripts/absolute-imports.mjs           # rewrite every file
//   node scripts/absolute-imports.mjs --check   # list what would change, exit 1 if any (part of `make check`)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const check = process.argv.includes("--check");
const TOP_SKIP = new Set([
  "node_modules",
  "target",
  ".nsh",
  ".git",
  ".scratch",
  "native",
  "fixtures",
  "fonts",
  "assets",
  "docs",
  "design",
  "scripts",
]);
const CODE = /\.(ts|tsx)$/;
const SPEC = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*|\.{1,2})\2/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (dir === root && TOP_SKIP.has(name)) continue;
    if (name === "node_modules" || name === ".git" || name === "target") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (CODE.test(name)) yield path;
  }
}

/** The code file a relative specifier names (with its extension), or null for an asset or a miss. */
function resolveFile(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && CODE.test(candidate)) return candidate;
  }
  return null;
}

/** The alias of a code file, or null when the import stays relative. */
function aliasOf(file) {
  const rel = relative(root, file).split(sep).join("/");
  if (rel === "components/kit/index.ts") return "#kit";
  if (rel.startsWith("lib/") && rel.endsWith(".ts")) return `#${rel.slice(0, -3)}`;
  if (rel.startsWith("components/") && !rel.startsWith("components/kit/") && rel.endsWith(".tsx"))
    return `#${rel.slice(0, -4)}`;
  return null;
}

const kit = join(root, "components", "kit") + sep;
const pending = [];
for (const file of walk(root)) {
  const text = readFileSync(file, "utf8");
  const inKit = file.startsWith(kit);
  const out = text.replace(SPEC, (all, lead, quote, spec) => {
    const to = resolveFile(file, spec);
    if (!to) return all;
    if (inKit && to.startsWith(kit)) return all;
    const name = aliasOf(to);
    return name ? `${lead}${quote}${name}${quote}` : all;
  });
  if (out !== text) {
    pending.push(relative(root, file));
    if (!check) writeFileSync(file, out);
  }
}
if (check) {
  if (pending.length) {
    console.error(
      `${pending.length} file(s) have relative project imports (run node scripts/absolute-imports.mjs):\n  ${pending.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log("imports ok");
} else {
  console.log(`${pending.length} file(s) rewritten`);
}
