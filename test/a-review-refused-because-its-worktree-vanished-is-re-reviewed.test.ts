import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FixProgressInput } from "../src/lib/fix-progress-judge.js";
import { readLedgerLines } from "../src/lib/status.js";
import { postReviewStatusGuarded } from "../src/lib/review.js";
import { checkReviewerCodeFreshness, checkReviewerCodeFreshnessAsync } from "../src/lib/self-sync.js";
import {
  REFUSED_POST_HOST_GAP_REREVIEW_STEP, runSweep, type OpenPrView, type SweepDeps,
} from "../src/lib/sweep.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * MIN).toISOString();
const PR_URL = "https://github.com/acme/remudero/pull/10783";
const HEAD = "2fd447d7e";
const VANISHED = "/nonexistent/worktrees/reviewer-e6cb1f765599";

const refusal = (minutesAgo: number, extra: Record<string, unknown>): Record<string, unknown> => ({
  ts: at(minutesAgo), task_id: "W1-T7850", step: "review.post_refused", pr_url: PR_URL, head_sha: HEAD,
  attempted_state: "success", reviewer_code_freshness: "unreadable",
  reviewer_code_reason: `git fetch origin failed in ${VANISHED}`, ...extra,
});

const openPr = (): OpenPrView => ({
  prNumber: 10783, prUrl: PR_URL, taskId: "W1-T7850", headSha: HEAD, headRefName: "run-W1-T7850-1",
  checksState: "green", reviewState: "pending", reviewPendingSince: at(30), unmetCriteria: [], priorStrikes: 0,
  autoMergeArmed: false, lastActivityAt: at(30), ciFailures: [],
});

interface Harness { rows: Record<string, unknown>[]; effects: string[]; deps: SweepDeps; judged: FixProgressInput[] }

function harness(rows: Record<string, unknown>[], judge?: SweepDeps["fixProgressJudge"]): Harness {
  const effects: string[] = [];
  const judged: FixProgressInput[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/vanished-worktree-ledger", runId: "vanished", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    dispatchFix: () => { effects.push("body"); },
    dispatchPlanOnlyRepair: () => { effects.push("plan"); return true; },
    postReview: (pr) => { effects.push(`review:${pr.prNumber}`); },
    arm: () => { effects.push("arm"); return "armed"; },
    escalate: (_pr, reason) => { effects.push(`escalate:${reason}`); },
    close: () => { effects.push("close"); },
    ...(judge ? { fixProgressJudge: async (input: FixProgressInput) => { judged.push(input); return judge(input); } } : {}),
  };
  return { rows, effects, deps, judged };
}

test("W1-T7850: a freshness read in a vanished checkout names the host gap", async () => {
  const guarded = { RMD_SELF_SYNC_DONE: "1" };
  const syncRead = checkReviewerCodeFreshness(VANISHED, guarded);
  const asyncRead = await checkReviewerCodeFreshnessAsync(VANISHED, guarded);
  for (const read of [syncRead, asyncRead]) {
    assert.equal(read.status, "unreadable");
    assert.equal((read as { hostGap?: string }).hostGap, "cwd-missing");
    assert.match((read as { reason: string }).reason, new RegExp(`reviewer checkout no longer exists: ${VANISHED}`));
  }
  // An unreadable reading in a checkout that still exists is not a host gap.
  const present = checkReviewerCodeFreshness(tmpdir(), { RMD_SELF_SYNC_DONE: "1" }, {
    checkServiceFreshness: () => ({ status: "degraded", reason: "ls-remote failed" }) as never,
  });
  assert.equal(present.status, "unreadable");
  assert.equal("hostGap" in present, false);
});

test("W1-T7850: the post refusal carries the host gap beside unreadable freshness", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-vanished-review-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const opts = (reviewerCodeFreshness: Parameters<typeof postReviewStatusGuarded>[0]["reviewerCodeFreshness"]) => ({
      owner: "acme", repo: "remudero", sha: "c".repeat(40), state: "success" as const,
      description: "remudero-review: PASS", taskId: "W1-T7850", evidence: "executed" as const, ledgerPath,
      runId: "W1-T7850-test", prUrl: PR_URL, fetchLifecycle: () => ({ state: "open" }) as never, reviewerCodeFreshness,
      post: () => { throw new Error("an unproven source must never publish"); },
    });
    const gap = await postReviewStatusGuarded(opts({ status: "unreadable", reason: "gone", hostGap: "cwd-missing" }));
    const plain = await postReviewStatusGuarded(opts({ status: "unreadable", reason: "ref lock" }));
    assert.equal(gap.posted, false);
    assert.equal(plain.posted, false);
    const [gapRow, plainRow] = readLedgerLines(ledgerPath).filter((line) => line.step === "review.post_refused");
    assert.equal(gapRow!.reviewer_code_freshness, "unreadable");
    assert.equal(gapRow!.reviewer_code_host_gap, "cwd-missing");
    assert.equal(plainRow!.reviewer_code_freshness, "unreadable");
    assert.equal("reviewer_code_host_gap" in plainRow!, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T7850: a vanished-worktree refusal is re-reviewed at the same head with no freshness backoff", async () => {
  // PR #10783's shape: a pending post, then a refusal 5m ago whose reviewer checkout was gone.
  const h = harness([refusal(5, { reviewer_code_host_gap: "cwd-missing" })]);
  const result = await runSweep([openPr()], { ...h.deps, reviewerCodeRecovery: {
    loadedCodeSha: "a".repeat(40), isLoadedCodeAtOrAfter: () => false } });
  const action = result.actions[0]!;
  assert.equal(action.disposition, "post-review");
  assert.equal(action.acted, true);
  assert.match(action.reason, /review worktree reclaimed/);
  assert.doesNotMatch(action.reason, /awaiting proven freshness/);
  assert.deepEqual(h.effects, ["review:10783"], "one fresh review of the same head, no repair, no arm");
  assert.equal(h.rows.some((row) => row.step === "sweep.reviewer_freshness_probe"), false, "no probe of the daemon's loaded code");
  const request = h.rows.find((row) => row.step === REFUSED_POST_HOST_GAP_REREVIEW_STEP);
  assert.equal(request?.head_sha, HEAD);
  assert.equal(request?.pr_url, PR_URL);
  assert.equal(request?.host_gap, "cwd-missing");
  assert.equal(request?.refusal_at, Date.parse(at(5)));

  // The same refusal is answered once: the next pass does not request a second re-review for it.
  const again = await runSweep([openPr()], h.deps);
  assert.equal(h.rows.filter((row) => row.step === REFUSED_POST_HOST_GAP_REREVIEW_STEP).length, 1);
  assert.equal(again.actions[0]!.disposition, "post-review");
});

test("W1-T7850: a repeat vanished-worktree refusal is paced and then escalated", async () => {
  // One re-review was already requested for the first refusal, and a second refusal followed 2m ago.
  // An earlier 2m review (disposed, then posted) gives the pace its observed duration.
  const earlier = [
    { ts: at(50), task_id: "W1-T7850", step: "sweep.disposed", pr_number: 10783, head_sha: HEAD, disposition: "post-review", acted: true },
    { ts: at(48), task_id: "W1-T7850", step: "review.posted", pr_url: PR_URL, head_sha: HEAD, state: "success" },
  ];
  const rows = [
    ...earlier,
    refusal(40, { reviewer_code_host_gap: "cwd-missing" }),
    { ts: at(38), task_id: "W1-T7850", step: REFUSED_POST_HOST_GAP_REREVIEW_STEP, pr_number: 10783, pr_url: PR_URL,
      head_sha: HEAD, refusal_at: Date.parse(at(40)), host_gap: "cwd-missing" },
    refusal(2, { reviewer_code_host_gap: "cwd-missing" }),
  ];
  const held = harness([...rows]);
  const heldResult = await runSweep([openPr()], held.deps);
  assert.equal(heldResult.actions[0]!.disposition, "wait");
  assert.match(heldResult.actions[0]!.reason, /host gap/);
  assert.deepEqual(held.effects, []);

  const escalating = harness([...rows.slice(0, 4), refusal(35, { reviewer_code_host_gap: "cwd-missing" })],
    async () => ({ verdict: "escalate", loop: "no-op", reason: "same gap twice" }) as never);
  const escalated = await runSweep([{ ...openPr(), reviewPendingSince: at(60) }], escalating.deps);
  assert.equal(escalated.actions[0]!.disposition, "blocked-ambiguous");
  assert.match(escalated.actions[0]!.reason, /host gap persists/);
  assert.deepEqual(escalating.effects.filter((effect) => effect.startsWith("review:")), []);
});

test("W1-T7850: an unreadable refusal with no host gap keeps the freshness backoff", async () => {
  const h = harness([refusal(1, {})]);
  const result = await runSweep([openPr()], h.deps);
  const action = result.actions[0]!;
  assert.equal(action.acted, false, "a ref-lock style refusal still backs off");
  assert.deepEqual(h.effects, []);
  assert.equal(h.rows.some((row) => row.step === REFUSED_POST_HOST_GAP_REREVIEW_STEP), false);
});
