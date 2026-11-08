import { expect, test } from "nsh/test";

import { commandSubject } from "#lib/tool-subject";

const HEREDOC = "python3 - <<'E' p='components/session-lab.tsx'\nimport re\ns=open(p).read()\nE";

const table: [string, string, string][] = [
  ["heredoc script", HEREDOC, "python3 script"],
  ["inline script", `python3 -c "print(1)"`, "python3 script"],
  ["node eval", "node -e 'console.log(1)'", "node script"],
  ["search with one place", "grep -n 'export.*\\(popup\\|picker\\)' lib", "grep export.*(popup|picker) in lib"],
  ["search with several places", "rg -n useState components/a.tsx components/b.tsx", "rg useState in 2 places"],
  ["search skips a flag's value", "rg -g '*.ts' useState lib", "rg useState in lib"],
  ["search without a place", "grep -rn TODO", "grep TODO"],
  ["a long pattern is cut", `grep ${"x".repeat(60)} lib`, `grep ${"x".repeat(27)}… in lib`],
  ["stream edit", "sed -n 108,118p components/composer-picker.tsx", "sed on components/composer-picker.tsx"],
  ["plain command stays", "pnpm test promo-eu", "pnpm test promo-eu"],
  ["redirection dropped", "pnpm test 2>&1", "pnpm test"],
  ["output redirect dropped", "ls -la > out.txt", "ls -la"],
  ["pipeline's tail dropped", "git log --oneline | head -5", "git log --oneline"],
  ["chain's tail dropped", "pnpm build && pnpm test", "pnpm build"],
  ["a leading cd is where, not what", "cd native/core && cargo test", "cargo test"],
  ["first line of several", "\n  make test\necho done", "make test"],
  ["empty", "   ", ""],
];
for (const [name, input, want] of table)
  test(`commandSubject: ${name}`, () => expect(commandSubject(input)).toBe(want));
