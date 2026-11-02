// W1-T11162 — a plan-only filing's review is lint plus grep proofs, so it is never started as a review run child, and
// it ledgers where its own time went. MEASURED 2026-11-02: a host plan review spent 15-134 s between
// review.pending_posted and review.reviewer.skipped with no row inside that span, against 9.5 s on the Mac.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { createDetachedWorkHost, type spawnRunChild, type startRunChildProbe } from "#src/lib/run-child.js";
import { readLedgerLines } from "#src/lib/status.js";
import { runReview } from "#src/run-task.js";

type Row = Record<string, unknown> & { step: string };

/** The production host over a fake launcher and probe, in the mode under test. */
function host(mode: "on" | "shadow") {
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-w1-t11162-host-"));
  const rows: Row[] = [];
  const launched: string[] = [];
  const probed: string[] = [];
  const detached = createDetachedWorkHost({
    stateRoot, repoDir: stateRoot, root: stateRoot, repo: "remudero",
    log: (step, extra) => void rows.push({ step, ...extra }),
    // A measured review drain wait is what places a code review as a child (detachedWorkPlacement).
    readLedger: () => [{ step: "daemon.freshness_drain.completed", duration_ms: 1_000,
      waited_on: [{ what: "review", kind: "review", settled_after_ms: 1_000 }] }],
    readMode: () => mode,
    spawn: (async (input: { taskId: string }) => {
      launched.push(input.taskId);
      return { started: true, runId: `child-${input.taskId}`, dir: stateRoot, pid: 1, settled: Promise.resolve(undefined),
        abort: async () => ({}) };
    }) as unknown as typeof spawnRunChild,
    probe: (async (input: { taskId: string }) => {
      probed.push(input.taskId);
      return { started: false, reason: "fixture probe" };
    }) as unknown as typeof startRunChildProbe,
  });
  return { detached, rows, launched, probed, cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) };
}

const HEAD = "4316e6a54481f8eeceff78da0cace36f0e07f7c9";

test("W1-T11162 criterion 1: a plan filing's review is never a run child, in mode on or shadow, and says where it ran", async () => {
  const on = host("on");
  try {
    const placed = await on.detached.spawnReview({
      pr: { prNumber: 16297, headSha: HEAD, isPlanFiling: true }, reviewKey: "review-key", reviewAttemptId: undefined,
    });
    assert.equal(placed, undefined, "undefined is the sweep's in-process review path");
    assert.deepEqual(on.launched, [], "no run child starts for a plan filing");
    const placement = on.rows.find((row) => row.step === "review.placement");
    assert.deepEqual(placement, { step: "review.placement", pr_number: 16297, head_sha: HEAD, placement: "in-process",
      reason: "plan-only-filing" });

    const code = await on.detached.spawnReview({
      pr: { prNumber: 16276, headSha: "b".repeat(40), isPlanFiling: false }, reviewKey: "code-key", reviewAttemptId: undefined,
    });
    assert.equal(code?.runId, "child-PR-16276", "a code review is still placed as a run child");
    assert.deepEqual(on.launched, ["PR-16276"]);
  } finally {
    on.cleanup();
  }

  const shadow = host("shadow");
  try {
    await shadow.detached.spawnReview({
      pr: { prNumber: 16297, headSha: HEAD, isPlanFiling: true }, reviewKey: "review-key", reviewAttemptId: undefined,
    });
    assert.deepEqual(shadow.probed, [], "a plan filing does not start the shadow probe either");
    await shadow.detached.spawnReview({
      pr: { prNumber: 16276, headSha: "b".repeat(40) }, reviewKey: "code-key", reviewAttemptId: undefined,
    });
    assert.deepEqual(shadow.probed, ["review-PR16276"], "a code review still probes in shadow");
  } finally {
    shadow.cleanup();
  }
});

const PLAN_ONLY_DIFF = [
  "diff --git a/plan/tasks.d/W1-T9999-x.yaml b/plan/tasks.d/W1-T9999-x.yaml",
  "--- a/plan/tasks.d/W1-T9999-x.yaml",
  "+++ b/plan/tasks.d/W1-T9999-x.yaml",
  "@@ -1,2 +1,2 @@",
  " - id: W1-T9999",
  "-  title: previous filing",
  "+  title: revised filing",
].join("\n");

const PLAN_PLUS_SRC_DIFF = [
  PLAN_ONLY_DIFF,
  "diff --git a/src/lib/worker.ts b/src/lib/worker.ts",
  "--- a/src/lib/worker.ts",
  "+++ b/src/lib/worker.ts",
  "@@ -1,1 +1,1 @@",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

const CRITERIA = [{ claim: "the plan-only review times its phases", proof: "the plan-only review times its phases for a filing changeset" }];
const REPORT = "The plan-only review times its phases for a filing changeset: plan-only review, times phases, filing changeset.";

/** One review with GitHub stubbed on PATH, no reviewer (spawnReviewer false) and the lint seam injected. */
async function reviewOnce(diffText: string): Promise<Row[]> {
  const logged: Row[] = [];
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t11162-review-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-w1-t11162-gh-"));
  const oldPath = process.env.PATH;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const diffFile = join(root, "diff.txt");
    writeFileSync(diffFile, diffText, "utf8");
    writeFileSync(join(binDir, "gh"), `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"${head}"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"${head}"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") cat ${JSON.stringify(diffFile)} ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    chmodSync(join(binDir, "gh"), 0o755);
    process.env.PATH = `${binDir}:${oldPath}`;
    await runReview({
      owner: "acme", repo: "remudero", prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T11162", acceptance: CRITERIA }, report: REPORT,
      settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as never,
      log: (step: string, extra?: Record<string, unknown>) => void logged.push({ step, ...extra }),
      say: () => {}, account: (r: never) => r,
      spawnReviewer: false,
      arm: () => "skipped", disarm: () => {},
      headCheckoutDir: REPO_ROOT,
      lintPlanForReviewFn: async () => ({ ran: true as const, label: "fixture", checked: 1, violations: [] }),
      materializeMs: 1_234,
      ledgerPath, runId: "REVIEW-W1-T11162-1",
    } as never);
    return [...logged, ...(readLedgerLines(ledgerPath) as Row[])];
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("W1-T11162 criterion 2: a plan-only review ledgers one row of its phases after its arm; a code review writes none", async () => {
  const rows = await reviewOnce(PLAN_ONLY_DIFF);
  const phases = rows.filter((row) => row.step === "review.plan_only_phases");
  assert.equal(phases.length, 1, `one phase row per plan-only review; saw ${rows.map((row) => row.step).join(", ")}`);
  const row = phases[0]!;
  assert.equal(row.pr_url, "https://github.com/acme/remudero/pull/1");
  assert.equal(row.materialize_ms, 1_234, "the caller's materialization time rides on the row");
  for (const field of ["diff_ms", "decision_ms", "lint_ms", "judge_ms", "post_ms", "arm_ms", "total_ms"]) {
    assert.equal(typeof row[field], "number", `${field} is measured`);
    assert.ok((row[field] as number) >= 0 && (row[field] as number) <= (row.total_ms as number), `${field} lies inside the review`);
  }
  const order = rows.map((r) => r.step);
  assert.ok(order.indexOf("review.posted") < order.indexOf("review.plan_only_phases"), "the row is written after the post");

  const code = await reviewOnce(PLAN_PLUS_SRC_DIFF);
  assert.equal(code.filter((r) => r.step === "review.plan_only_phases").length, 0, "a review that is not plan-only writes no phase row");
  assert.ok(code.some((r) => r.step === "review.posted"), "the control review did post, so its missing row is not a crash");
});
