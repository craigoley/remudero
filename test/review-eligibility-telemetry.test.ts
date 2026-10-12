import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, drainInFlightReviews, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger, rotateLedger } from "../src/lib/ledger.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-eligibility-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const deps: SweepDeps = {
    ledgerPath, runId: "review-telemetry-fixture", now: () => Date.now(),
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    readActiveWorkerCount: () => 0,
  };
  return { deps, rows: () => readLedgerLines(ledgerPath), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function pr(number: number, overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: number, prUrl: `https://github.com/fixture/repo/pull/${number}`, taskId: `T-${number}`,
    headSha: `head-${number}`, reviewInputDigest: `input-${number}`, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    createdAt: new Date(Date.now() - number * 60_000).toISOString(), lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

test("review eligibility is durable for waiting exact inputs before the light admission bound", async () => {
  const fx = fixture();
  const posted: number[] = [];
  try {
    fx.deps.postReview = p => {
      const rows = fx.rows();
      assert.equal(rows.filter(row => row.step === "sweep.review_eligible").length, 2,
        "both eligible heads are observed before the first admitted review starts");
      const admitted = rows.filter(row => row.step === "sweep.review_admitted");
      assert.equal(admitted.length, 1);
      assert.equal(admitted[0]!.head_sha, p.headSha);
      assert.equal(admitted[0]!.review_input_digest, p.reviewInputDigest);
      assert.equal(admitted[0]!.observation_version, 1);
      posted.push(p.prNumber);
    };
    const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1, reviewLaneMin: 1, reviewLaneMax: 1 };
    await runSweepLightPass([pr(1), pr(2), pr(3, { checksState: "red" })], fx.deps, policy);
    assert.equal(await drainInFlightReviews({ boundMs: 1_000 }), 0);
    assert.equal(posted.length, 1, "telemetry spends no additional review lane");
    const eligible = fx.rows().filter(row => row.step === "sweep.review_eligible");
    assert.deepEqual(eligible.map(row => row.pr_number), [1, 2]);
    assert.ok(eligible.every(row => row.surface === "light" && row.observation_version === 1 && typeof row.review_key === "string"));
    const waiting = fx.rows().find(row => row.step === "sweep.disposed" && row.pr_number !== posted[0] && row.pr_number !== 3);
    assert.match(String(waiting?.stand_down_reason), /not admitted/);
  } finally { fx.cleanup(); }
});

test("eligibility observations suppress repeated polls but reopen for a changed body on the same head", async () => {
  const fx = fixture();
  try {
    fx.deps.actionable = () => false;
    const initial = pr(1);
    await runSweepLightPass([initial], fx.deps);
    await runSweepLightPass([initial], fx.deps);
    assert.equal(fx.rows().filter(row => row.step === "sweep.review_eligible").length, 1);
    await runSweepLightPass([{ ...initial, reviewInputDigest: "changed-body" }], fx.deps);
    const eligible = fx.rows().filter(row => row.step === "sweep.review_eligible");
    assert.equal(eligible.length, 2);
    assert.notEqual(eligible[0]!.review_key, eligible[1]!.review_key);
    assert.equal(fx.rows().filter(row => row.step === "sweep.review_admitted").length, 0);
  } finally { fx.cleanup(); }
});

test("full review eligibility and admission precede posting and remain available after ledger rotation", async () => {
  const fx = fixture();
  try {
    fx.deps.postReview = p => {
      const rows = fx.rows();
      const eligible = rows.findIndex(row => row.step === "sweep.review_eligible");
      const admitted = rows.findIndex(row => row.step === "sweep.review_admitted");
      assert.ok(eligible >= 0 && admitted > eligible);
      assert.equal(rows[eligible]!.review_key, rows[admitted]!.review_key);
      appendLedger(fx.deps.ledgerPath, { run_id: "fixture", task_id: p.taskId!, step: "review.posted", headSha: p.headSha, pr_url: p.prUrl });
    };
    await runSweep([pr(1)], fx.deps);
    const before = fx.rows().filter(row => row.step === "sweep.review_eligible" || row.step === "sweep.review_admitted");
    assert.equal(before.length, 2);
    appendLedger(fx.deps.ledgerPath, { run_id: "fixture", task_id: "noise", step: "test.noise", padding: "x".repeat(100_000) });
    assert.equal(rotateLedger(fx.deps.ledgerPath, { ceilingBytes: 65_536 }).rotated, true,
      "force real rotation while leaving room for the retained decision core");
    assert.deepEqual(fx.rows().filter(row => row.step === "sweep.review_eligible" || row.step === "sweep.review_admitted"), before);
  } finally { fx.cleanup(); }
});

test("dry-run review telemetry writes no eligibility or admission receipts", async () => {
  const fx = fixture();
  try {
    fx.deps.dryRun = true;
    await runSweepLightPass([pr(1)], fx.deps);
    assert.deepEqual(fx.rows(), []);
  } finally { fx.cleanup(); }
});

test("the production review attempt retains the same exact input identity as eligibility", async () => {
  const fx = fixture();
  try {
    const candidate = pr(1);
    fx.deps.actionable = () => false;
    await runSweepLightPass([candidate], fx.deps);
    const effects = buildSweepEffects({
      owner: "fixture", repo: "repo", config: { root: fx.deps.ledgerPath, claudeBin: "/bin/true" } as Config,
      ledgerPath: fx.deps.ledgerPath, runId: fx.deps.runId,
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: (step, extra) => appendLedger(fx.deps.ledgerPath, { run_id: "fixture", task_id: candidate.taskId!, step, ...extra }),
      reviewRunner: async () => 0, armSessionPrsOverride: false,
      issuesImpl: { create: () => "https://github.com/fixture/repo/issues/1" }, stallNotice: () => {},
    });
    await effects.postReview!(candidate);
    const eligible = fx.rows().find(row => row.step === "sweep.review_eligible")!;
    const attempted = fx.rows().find(row => row.step === "sweep.post_review.attempt")!;
    assert.equal(attempted.review_key, eligible.review_key);
    assert.equal(attempted.review_input_digest, candidate.reviewInputDigest);
    assert.equal(attempted.pr_url, eligible.pr_url);
    assert.equal(attempted.head_sha, eligible.head_sha);
  } finally { fx.cleanup(); }
});
