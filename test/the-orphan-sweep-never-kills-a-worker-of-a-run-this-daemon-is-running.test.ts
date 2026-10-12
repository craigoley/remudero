import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { acquireInflightLock } from "../src/lib/inflight-lock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { sweepOrphanWorkers, type OrphanMarkers, type OrphanSweepReport } from "../src/lib/worker-containment.js";

// W1-T5998 — runDaemon's per-poll orphan sweep counted a run as active only while its id held a
// state/inflight lock. Review workers take none, and a sweep fix worker carries the daemon's own
// DAEMON-<ms> id while its lock records DAEMON-<ms>:fix-claim:<pr>:<ms>, so the sweep killed live
// workers of the running daemon (13 worker_orphan_killed rows on 2026-10-06). These tests drive
// the REAL sweepOrphanWorkers with the isRunActive the daemon builds. The symbols this change adds
// are read through a dynamic import, so the file still loads, and fails, against the old code.

const REPO_ROOT = process.cwd();
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const SCOPE = "rmd-v1-orphan-sweep-fixture";
const OWN_DAEMON = "DAEMON-1791285335358";
const PREVIOUS_DAEMON = "DAEMON-1791279951516";

type RunActive = (ownRunId: string, inflightDir: string, isPidAlive?: (pid: number) => boolean) => (runId: string) => boolean;

async function productionRunActive(): Promise<RunActive> {
  const mod = (await import("../src/run-task.js")) as Record<string, unknown>;
  const factory = mod.orphanSweepRunActive;
  assert.equal(typeof factory, "function", "run-task.ts must export the isRunActive the daemon's sweep uses");
  return factory as RunActive;
}

/** One sweep over a single attributed candidate; kills and ledger rows are recorded, never sent. */
function sweepOne(markers: OrphanMarkers, isRunActive: (runId: string) => boolean): OrphanSweepReport & { signalled: number[] } {
  const signalled: number[] = [];
  const report = sweepOrphanWorkers({
    expectedScope: SCOPE,
    listCandidates: () => [{ pid: 424242, cmdline: "claude --worker" }],
    readMarkers: () => ({ ...markers, scope: SCOPE }),
    isRunActive,
    kill: (pid) => signalled.push(pid),
    ledger: () => {},
  });
  return { ...report, signalled };
}

function inflightDir(): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}orphan-sweep-active-`)), "state", "inflight");
}

test("the orphan sweep leaves a live review worker alone while its review runs, and kills it once the review returned", async () => {
  const runActive = await productionRunActive();
  const { reviewCommand } = await import("../src/run-task.js");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}orphan-sweep-review-`));
  const isRunActive = runActive(OWN_DAEMON, join(root, "state", "inflight"));
  let reviewRunId: string | undefined;
  let duringReview: OrphanSweepReport & { signalled: number[] } | undefined;
  try {
    const deps = {
      fetchView: () => ({
        headRefOid: HEAD,
        headRefName: "codex/orphan-sweep-fixture",
        body: "## Acceptance\n- it works | grep: review in src/lib/review.ts\n",
        url: "https://github.com/craigoley/remudero/pull/9539",
        number: 9539,
      }),
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }),
      runReview: async (args: { runId: string }) => {
        reviewRunId = args.runId;
        duringReview = sweepOne({ runId: args.runId, taskId: "PR-9539" }, isRunActive);
        return { state: "success", headSha: HEAD, reviewerOutcome: "not_attempted", criteria: [] };
      },
      executionMode: "semantic" as const,
    };
    await reviewCommand("codex/orphan-sweep-fixture", ["--repo", "craigoley/remudero"], deps as never);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(reviewRunId ?? "", /^review-PR9539-\d+$/, "the review must reach its worker spawn");
  assert.deepEqual(duringReview?.signalled, [], "a review worker of a review still running must never be signalled");
  assert.equal(duringReview?.leftAlone[0]?.reason, "run_active");

  const afterReview = sweepOne({ runId: reviewRunId ?? "", taskId: "PR-9539" }, isRunActive);
  assert.deepEqual(afterReview.signalled, [424242], "a worker of a review that already returned is a stray");
});

test("the orphan sweep leaves alone a fix worker carrying this daemon's own run id", async () => {
  const runActive = await productionRunActive();
  const report = sweepOne({ runId: OWN_DAEMON, taskId: "PR-9505" }, runActive(OWN_DAEMON, inflightDir()));
  assert.deepEqual(report.signalled, []);
  assert.equal(report.leftAlone[0]?.reason, "run_active");
});

test("the orphan sweep leaves alone a fix worker whose run id prefixes a live fix-claim lock", async () => {
  const runActive = await productionRunActive();
  const dir = inflightDir();
  const otherLiveDaemon = "DAEMON-1791286000000";
  acquireInflightLock(dir, "fix-branch-claim-9505", { run_id: `${otherLiveDaemon}:fix-claim:9505:1791286100000` });
  const report = sweepOne({ runId: otherLiveDaemon, taskId: "PR-9505" }, runActive(OWN_DAEMON, dir));
  assert.deepEqual(report.signalled, [], "a live fix-claim lock names a running fix round");
});

test("the orphan sweep still kills a worker attributed to a previous daemon's ended run", async () => {
  const runActive = await productionRunActive();
  const dir = inflightDir();
  // The previous daemon's claim outlived its process: a dead holder is not a running round.
  acquireInflightLock(dir, "fix-branch-claim-9528", {
    run_id: `${PREVIOUS_DAEMON}:fix-claim:9528:1791280000000`,
    info: { pid: 7 },
  });
  const isPidAlive = (pid: number) => pid === process.pid;
  const report = sweepOne({ runId: PREVIOUS_DAEMON, taskId: "PR-9528" }, runActive(OWN_DAEMON, dir, isPidAlive));
  assert.deepEqual(report.signalled, [424242]);
  assert.deepEqual(report.killed.map((k) => k.run_id), [PREVIOUS_DAEMON]);
});
