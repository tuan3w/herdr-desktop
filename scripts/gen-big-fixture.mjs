// Writes `fixtures/herdr/big.json`: a scripted herdr with 200 agents over 25 projects, 3 of them repositories with linked
// worktrees (31 workspaces), for the `.perf/` scenarios that need a crowd. Everything is invented and the output is
// deterministic (a fixed pseudo-random sequence), so the file only changes when this script does.
//
//   bun scripts/gen-big-fixture.mjs
import { writeFileSync } from "node:fs";

let seed = 20241107;
/** A deterministic number in [0, 1): mulberry32. */
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];

const REPOS = [
  { name: "ledger-core", trees: ["", "-hotfix", "-reports", "-import-v2"] },
  { name: "storefront", trees: ["", "-checkout-flow", "-search"] },
  { name: "infra-tools", trees: ["", "-backup"] },
];
const PLAIN = [
  "notes",
  "scripts",
  "docs site",
  "billing",
  "mailer",
  "scheduler",
  "gateway",
  "search index",
  "auth",
  "metrics",
  "etl",
  "mobile api",
  "admin panel",
  "queue workers",
  "cache",
  "reports",
  "analytics",
  "onboarding",
  "audit log",
  "exports",
  "webhooks",
  "sandbox",
];
const AGENTS = ["claude", "omp", "codex", "pi"];
const VERBS = ["Refactor", "Fix", "Add", "Migrate", "Document", "Review", "Trim", "Test", "Rename", "Split"];
const NOUNS = [
  "invoice totals",
  "retry policy",
  "login flow",
  "date parsing",
  "config loader",
  "queue backoff",
  "csv export",
  "rate limits",
  "cache keys",
  "error pages",
  "audit trail",
  "schema checks",
];

// 200 agents: how many in each state, spread by a shuffle.
const STATES = [
  ...Array(12).fill("blocked"),
  ...Array(26).fill("done"),
  ...Array(40).fill("working"),
  ...Array(110).fill("idle"),
  ...Array(12).fill("unknown"),
];
for (let i = STATES.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [STATES[i], STATES[j]] = [STATES[j], STATES[i]];
}

const workspaces = [];
for (const repo of REPOS) {
  for (const tree of repo.trees) {
    workspaces.push({
      label: `${repo.name}${tree}`,
      agents: 5,
      worktree: {
        repo_key: `git:${repo.name}`,
        repo_name: repo.name,
        repo_root: `/home/dev/${repo.name}`,
        checkout_path: `/home/dev/${repo.name}${tree}`,
        is_linked_worktree: tree !== "",
      },
    });
  }
}
const PLAIN_AGENTS = 200 - workspaces.reduce((n, w) => n + w.agents, 0);
PLAIN.forEach((label, i) =>
  workspaces.push({
    label,
    agents: Math.floor(PLAIN_AGENTS / PLAIN.length) + (i < PLAIN_AGENTS % PLAIN.length ? 1 : 0),
    cwd: `/home/dev/${label.replace(/ /g, "-")}`,
  }),
);

const rule = (rgb) => `\u001b[0m\u001b[38;2;${rgb}m${"─".repeat(96)}\u001b[0m`;
const prompt = (task) => [
  "",
  `\u001b[0m\u001b[38;2;153;153;153m  \u001b[0mRunning the checks for ${task}`,
  `\u001b[0m\u001b[38;2;153;153;153m  ⎿  $ npm test -- --run\u001b[0m`,
  "",
  rule("177;185;249"),
  " \u001b[0m\u001b[1m\u001b[38;2;177;185;249mBash command\u001b[0m",
  " \u001b[0m\u001b[38;2;153;153;153mRun the test suite once\u001b[0m",
  " npm test -- --run",
  " Do you want to proceed?",
  " \u001b[0m\u001b[38;2;177;185;249m❯ \u001b[0m\u001b[38;2;153;153;153m1. \u001b[0m\u001b[38;2;177;185;249mYes\u001b[0m",
  "   \u001b[0m\u001b[38;2;153;153;153m2. \u001b[0mYes, and don't ask again for \u001b[0m\u001b[1mnpm test:*\u001b[0m",
  "   \u001b[0m\u001b[38;2;153;153;153m3. \u001b[0mNo",
  "",
  " \u001b[0m\u001b[38;2;153;153;153mEsc to cancel · Tab to amend\u001b[0m",
];
const plain = (state, task) => [
  `  \u001b[38;2;153;153;153mReading\u001b[0m ${task.toLowerCase()}`,
  "  Applying the change to 3 files",
  state === "working"
    ? "  ⠋ Working (1m 08s · esc to interrupt)"
    : state === "done"
      ? "  Done. 3 files changed, tests pass."
      : "  Waiting for the next instruction.",
];

const snapshot = {
  version: "0.9.5",
  protocol: 22,
  focused_workspace_id: "w1",
  workspaces: [],
  tabs: [],
  panes: [],
  layouts: [],
  agents: [],
};
const screens = {};
let next = 0;
workspaces.forEach((ws, index) => {
  const id = `w${index + 1}`;
  const tab = `${id}:t1`;
  snapshot.workspaces.push({
    workspace_id: id,
    number: index + 1,
    label: ws.label,
    focused: index === 0,
    pane_count: ws.agents,
    tab_count: 1,
    active_tab_id: tab,
    agent_status: "idle",
    ...(ws.worktree ? { worktree: ws.worktree } : {}),
  });
  snapshot.tabs.push({
    tab_id: tab,
    workspace_id: id,
    number: 1,
    label: "main",
    focused: index === 0,
    pane_count: ws.agents,
    agent_status: "idle",
  });
  for (let k = 1; k <= ws.agents; k++) {
    const pane = `${id}:p${k}`;
    const state = STATES[next++];
    const agent = pick(AGENTS);
    const task = `${pick(VERBS)} ${pick(NOUNS)}`;
    const cwd = ws.worktree ? ws.worktree.checkout_path : ws.cwd;
    const named = k % 3 === 0 ? { label: task } : { terminal_title: task, terminal_title_stripped: task };
    snapshot.panes.push({
      pane_id: pane,
      terminal_id: `t${pane}`,
      workspace_id: id,
      tab_id: tab,
      focused: false,
      agent_status: state,
      revision: next,
      agent,
      cwd,
      ...named,
    });
    snapshot.agents.push({
      terminal_id: `t${pane}`,
      agent_status: state,
      workspace_id: id,
      tab_id: tab,
      pane_id: pane,
      focused: false,
      revision: next,
      agent,
      cwd,
      ...named,
      state_change_seq: next,
    });
    screens[pane] = { screen: state === "blocked" ? prompt(task) : plain(state, task) };
  }
});

writeFileSync(
  new URL("../fixtures/herdr/big.json", import.meta.url),
  `${JSON.stringify({ snapshot, panes: screens }, null, 1)}\n`,
);
console.log(`${snapshot.agents.length} agents, ${snapshot.workspaces.length} workspaces`);
