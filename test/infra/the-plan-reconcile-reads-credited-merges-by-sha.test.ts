// W1-T15031: the plan reconcile reads each credited PR's own merge evidence by sha, not a fixed window of recent commits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan } from "#src/lib/plan.js";
import { buildBatchedGithub, buildCommitTrailerIndex } from "#src/lib/status.js";
import { MERGED_PATHS_SCAN_LIMIT, buildCreditCandidates, creditCandidatesFromProjection, creditIsReconcilable, withCreditedMergePaths } from "#src/lib/tick-read-worker.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const TASK = "W1-T15100";
const url = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;
const OLD_SHA = "a".repeat(40);
const RECENT_SHA = "b".repeat(40);

/** The credited ids the real credit builder reports over a real history: the reconcile's own filter. */
function realHistory(root: string): Set<string> {
  const commit = (message: string, build: boolean) =>
    `commit refs/heads/main\ncommitter ${GIT_REPO_FIXTURE_IDENTITY.name} <${GIT_REPO_FIXTURE_IDENTITY.email}> 1700000000 +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${build ? "M 100644 inline src/example.ts\ndata 6\nbuild\n\n" : ""}\n`;
  // The build lands first, then more commits than the former 5000-commit subject window and the path window held.
  const fillers = Array.from({ length: Math.max(5000, MERGED_PATHS_SCAN_LIMIT) + 50 }, (_, i) => commit(`chore: filler ${i}`, false)).join("");
  execFileSync("git", ["-C", root, "fast-import", "--quiet"], { input: commit(`feat(x): build (#5100)\n\nRemudero-Task: ${TASK}\n`, true) + fillers });
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/craigoley/remudero.git"]);
  writeFileSync(join(root, "state", "ledger.ndjson"), JSON.stringify({ ts: "2026-09-01T00:00:00Z", step: "pr.opened", task_id: TASK, pr_url: url(5100) }) + "\n");
  const github = buildBatchedGithub("craigoley", "remudero", {
    exec: (args) => JSON.stringify(args.some((arg) => arg.includes("state=closed")) ? [{
      number: 5100, html_url: url(5100), state: "closed", merged_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
      head: { ref: `run-${TASK}-1` }, body: `Remudero-Task: ${TASK}\n`,
    }] : []),
    commitTrailerIndex: buildCommitTrailerIndex({ slug: "craigoley/remudero", cwd: root }),
  });
  const plan = loadPlan(join(root, "plan", "tasks.yaml"));
  const candidates = buildCreditCandidates("craigoley", "remudero", plan, join(root, "state", "ledger.ndjson"), undefined, github, () => root);
  return new Set(candidates.filter(creditIsReconcilable).map((c) => c.taskId));
}

test("W1-T15031 criterion 1: a credited merge older than the window is judged", () => {
  const projection = [
    { taskId: TASK, merged: true, prNumber: 18550, prUrl: url(18550) },
    { taskId: "W1-T15101", merged: true, prNumber: 21000, prUrl: url(21000) },
  ];
  const windowPaths = new Map([[21000, ["src/recent.ts"]]]);
  const shaByPr = new Map([[18550, OLD_SHA], [21000, RECENT_SHA]]);
  const reads: Array<readonly string[]> = [];
  // The injected git log answers by sha alone: it is never asked about a merge the window already holds.
  const paths = withCreditedMergePaths("/repo", projection, windowPaths, shaByPr, (root, shas) => {
    assert.equal(root, "/repo");
    reads.push(shas);
    return new Map(shas.includes(OLD_SHA) ? [[18550, ["src/old-build.ts"]]] : []);
  });
  assert.deepEqual(reads, [[OLD_SHA]]);
  assert.deepEqual(paths.get(18550), ["src/old-build.ts"]);
  assert.deepEqual(paths.get(21000), ["src/recent.ts"]);
  const subjects = new Map([[18550, "feat(x): old build (#18550)"], [21000, "feat(y): recent (#21000)"]]);
  const [old] = creditCandidatesFromProjection(projection.slice(0, 1) as never, subjects, new Map(), paths);
  assert.equal(old!.creditHasBuildDiff, true);
  assert.equal(creditIsReconcilable(old!), true);
  // Restore the window: without the by-sha read the same merge has no paths, and its diff reads unknown.
  const [windowed] = creditCandidatesFromProjection(projection.slice(0, 1) as never, new Map(), new Map(), windowPaths);
  assert.equal(windowed!.creditHasBuildDiff, undefined);
  // The real seam: over a git history longer than both former windows, the credited merge is read by sha and judged.
  const repo = gitRepo({ kind: "w1-t15031", seedCommit: false });
  try {
    mkdirSync(join(repo.dir, "state"));
    mkdirSync(join(repo.dir, "plan"));
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"),
      `- id: ${TASK}\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  budget_usd: 1\n  status: queued\n  acceptance:\n    - claim: c\n      proof: "unit test: x"\n`);
    assert.deepEqual(realHistory(repo.dir), new Set([TASK]));
  } finally {
    repo.cleanup();
  }
});

test("W1-T15031: no read runs when every credited merge is in the window, unmerged, or has no known sha", () => {
  let reads = 0;
  const paths = withCreditedMergePaths("/repo", [
    { merged: true, prNumber: 1 }, { merged: false, prNumber: 2 }, { merged: true, prNumber: 3 }, { merged: true },
  ], new Map([[1, ["src/a.ts"]]]), new Map([[1, OLD_SHA], [2, RECENT_SHA]]), () => {
    reads++;
    return new Map();
  });
  assert.equal(reads, 0);
  assert.deepEqual([...paths], [[1, ["src/a.ts"]]]);
});
