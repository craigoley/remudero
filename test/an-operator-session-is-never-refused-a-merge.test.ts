import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W1-T9643 — operator ruling 2026-10-15: never block merges. Rule 5 of hooks/deny-floor.sh keeps a WORKER from
// merging or arming its own PR (the orchestrator merges every green PR and leaves its receipts), but it never read
// the lane, so it refused the operator's own `gh pr merge` too. These cases run the real hook, as the interactive
// lane (.claude/settings.json, no flag) and the worker lane (settings/worker.json, `--confine-file-tools`) call it.

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));
const WORKER_LANE = ["--confine-file-tools"];

const MERGE_ROUTES = [
  "gh pr merge 42 --squash",
  "gh pr merge https://github.com/o/r/pull/42 --auto --squash",
  "gh --repo o/r pr merge 42 --squash",
  "gh -R=o/r pr merge 42 --auto --squash",
  "gh api -X PUT repos/o/r/pulls/42/merge -f merge_method=squash",
  "gh api repos/o/r/pulls/42/merge --method=PUT -f merge_method=squash",
  `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { pullRequest { merged } } }'`,
  `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_x"}) { pullRequest { autoMergeRequest { enabledAt } } }'`,
];

// A fresh cache root per call, as test/deny-floor.test.ts does: rule 9 paces read-shaped `gh` calls by a stamp
// under $XDG_CACHE_HOME, and a shared stamp would make one case refuse the next.
function runFloor(command: string, args: readonly string[]): { status: number | null; stderr: string } {
  const cacheHome = mkdtempSync(join(tmpdir(), "rmd-denyfloor-cache-"));
  try {
    const result = spawnSync("bash", [HOOK_PATH, ...args], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
}

test("W1-T9643: an operator session is never refused a merge or an auto-merge", () => {
  for (const command of MERGE_ROUTES) {
    const { status, stderr } = runFloor(command, []);
    assert.equal(status, 0, `an operator session was refused: ${command}\n${stderr}`);
  }
  for (const command of ["gh pr view 42 --json state", "gh pr diff https://github.com/o/r/pull/42"]) {
    assert.equal(runFloor(command, []).status, 0, `an operator read was refused: ${command}`);
  }
});

test("W1-T9643: the worker lane still routes every merge through the orchestrator", () => {
  for (const command of MERGE_ROUTES) {
    const { status, stderr } = runFloor(command, WORKER_LANE);
    assert.equal(status, 2, `a worker merge route was let through: ${command}`);
    assert.match(stderr, /only the orchestrator|merge endpoint|GraphQL mutation/i);
  }
  for (const command of ["gh pr view 42 --json state", "gh pr diff https://github.com/o/r/pull/42"]) {
    assert.equal(runFloor(command, WORKER_LANE).status, 0, `a worker read was refused: ${command}`);
  }
});
