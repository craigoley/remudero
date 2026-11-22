// W1-T13151 — an aborted review lane posts no binding verdict. MEASURED 2026-11-16 on PR #18803: the restart
// drain abandoned the review (src/lib/sweep.ts drainInFlightReviews aborts its lane signal), the review kept
// running, its plan lint returned {ran: false, reason: "lint-plan aborted"}, and the review posted that as a
// binding remudero-review FAILURE although every criterion was met. The exact reuse path then re-posted it on
// the next head 10 s after admission. Invariants: aborted-is-not-judged, and a-lint-that-never-ran-is-no-pass.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
// A namespace import, so this file still loads at the merge base and its tests fail there as tests.
import * as ledger from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { CensusChildResult } from "#src/cli/commands/run-task-verb.js";
import type { PlanLintOutcome, ReviewVerdict } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
// The shared run-task test helper, not a direct src/run-task.ts import (the affected-suite reach ratchet bounds direct importers).
import { buildOpenPrViews, buildSweepEffects, lintPlanForReview, runReview } from "#test/helpers/run-task-test.js";
import { drainInFlightReviews, trackInFlightReview, type OpenPrView, type ReviewReuseInputs } from "#src/lib/sweep.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type SweepDeps } from "#test/helpers/sweep-test.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const { appendLedger } = ledger;
const REVIEW_LANE_ABORTED_STEP = "review.lane_aborted";
const TASK_ID = "W1-T13151";
const PR_NUMBER = 18803;
const PR_URL = `https://github.com/acme/remudero/pull/${PR_NUMBER}`;
const HEAD_SHA = "7b3b501f1aaabbbbccccddddeeeeffff00001111";
const NEXT_HEAD = "fd7800caa1112222333344445555666677778888";
const SHARD = `plan/tasks.d/${TASK_ID}.yaml`;
// A plan-only diff: the review skips the advisory reviewer and rests its PASS on its own lint-plan run.
const DIFF = [
  `diff --git a/${SHARD} b/${SHARD}`, `--- a/${SHARD}`, `+++ b/${SHARD}`, "@@ -1 +1 @@",
  "-status: queued", "+status: queued # noted",
].join("\n");
const CRITERION = { claim: "the shard carries its note", proof: `grep: noted ${SHARD}` };
// One line: the shim echoes its stdout. The body names the task, so the sweep's view keys it the way the review does.
const BODY = `Remudero-Task: ${TASK_ID} Acceptance: ${CRITERION.claim} — ${CRITERION.proof} matched`;
const CLEAN_LINT: PlanLintOutcome = { ran: true, label: "fixture", checked: 1, violations: [] };
const WITHHELD = "plan-only PASS withheld, lint-plan could not run";

type LintRun = (argv: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<CensusChildResult>;

interface Harness {
  root: string;
  ledgerPath: string;
  shim: GhShim;
  rows: () => Array<Record<string, unknown>>;
  /** Every remudero-review status POST's state, in order. */
  statusPosts: () => string[];
  descriptions: () => string[];
  cleanup: () => void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13151-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "head", "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "head", "plan", "tasks.yaml"), "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "headRefOid", stdout: JSON.stringify({ headRefOid: HEAD_SHA }) },
    { when: "pr diff", stdout: DIFF },
    { when: "pulls/", stdout: JSON.stringify({ number: PR_NUMBER, html_url: PR_URL, updated_at: "t", body: BODY, state: "open",
      head: { ref: `run-${TASK_ID}-1`, sha: HEAD_SHA } }) },
    { when: "/status", stdout: JSON.stringify({ state: "pending", statuses: [] }) },
  ], { kind: "t13151" });
  const posts = () => shim.calls().filter((call) => call.includes(`statuses/${HEAD_SHA}`) && call.includes("context=remudero-review"));
  return {
    root, ledgerPath, shim,
    rows: () => readLedgerLines(ledgerPath),
    statusPosts: () => posts().map((call) => /state=(\w+)/.exec(call)?.[1] ?? "unknown"),
    descriptions: () => posts().map((call) => /description=(.*)$/.exec(call)?.[1] ?? ""),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(shim.dir, { recursive: true, force: true });
    },
  };
}

/** Drives the REAL review command (the daemon's runReview) on a plan-only PR. The lint seam runs the REAL
 *  lintPlanForReview over the fixture head with Git stubbed and the child replaced by `run`. */
async function review(h: Harness, opts: { runId: string; run?: LintRun; lint?: PlanLintOutcome; signal?: AbortSignal;
  onPhase?: (phase: string) => void }) {
  const priorPath = process.env.PATH;
  process.env.PATH = `${h.shim.dir}:${priorPath ?? ""}`;
  try {
    return await withLiveWritesAllowed(() => runReview({
      owner: "acme", repo: "remudero", prUrl: PR_URL,
      task: { id: TASK_ID, acceptance: [CRITERION] },
      report: BODY, settingsFile: join(h.root, "settings.json"),
      config: { claudeBin: "/bin/true", root: h.root } as Config,
      log: (step, extra = {}) => appendLedger(h.ledgerPath, { run_id: opts.runId, task_id: TASK_ID, step, lane: "review", ...extra }),
      say: () => {}, account: (r: WorkerResult) => r, spawnReviewer: false,
      readReviewReuseFacts: () => undefined,
      lintPlanForReviewFn: (_dir, _git, _run, options) => opts.lint !== undefined ? Promise.resolve(opts.lint)
        : lintPlanForReview(join(h.root, "head"), async () => "HEAD", opts.run, options),
      disarm: () => "not-armed" as const,
      arm: async () => "armed" as const,
      ledgerPath: h.ledgerPath, runId: opts.runId,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
    }));
  } finally {
    process.env.PATH = priorPath;
  }
}

/** A lint child that runs until the lane signal kills it, the way spawnReviewPlanLint's group kill ends. */
function waitingChild(onStart: () => void): LintRun {
  return (_argv, { signal }) => new Promise((resolve) => {
    const killed = () => resolve({ status: null, signal: "SIGKILL", stdout: "", stderr: "" });
    if (signal?.aborted) return killed();
    signal?.addEventListener("abort", killed, { once: true });
    onStart();
  });
}

function assertLaneAborted(h: Harness, result: Awaited<ReturnType<typeof review>>, runId: string) {
  assert.deepEqual(h.statusPosts().filter((state) => state !== "pending"), [],
    `an aborted lane posts no binding remudero-review status; posts: ${h.statusPosts().join(",")}`);
  assert.equal(h.rows().filter((row) => row.step === "review.posted").length, 0, "no review.posted row is written");
  const aborted = h.rows().filter((row) => row.step === REVIEW_LANE_ABORTED_STEP);
  assert.equal(aborted.length, 1, `exactly one review.lane_aborted row: ${JSON.stringify(aborted)}`);
  assert.equal((ledger as Record<string, unknown>).REVIEW_LANE_ABORTED_STEP, REVIEW_LANE_ABORTED_STEP, "the step is registered in the ledger module");
  assert.equal(aborted[0]!.run_id, runId);
  assert.equal(aborted[0]!.pr_number, PR_NUMBER);
  assert.equal(aborted[0]!.pr_url, PR_URL);
  assert.equal(aborted[0]!.head_sha, HEAD_SHA);
  assert.equal(aborted[0]!.phase, "plan-lint");
  assert.equal(aborted[0]!.reason, "lint-plan aborted");
  assert.equal(result.state, "pending", "the review ends non-terminal");
  assert.equal(result.verdictWithheld, "lane aborted: lint-plan aborted");
  assert.deepEqual(result.planLint, { ran: false, reason: "lint-plan aborted", aborted: true });
}

test("W1-T13151 criterion 1: a plan-only review whose lane aborts before or during its plan lint posts no verdict", async (t) => {
  await t.test("aborted before the plan lint starts", async () => {
    const h = harness();
    try {
      const controller = new AbortController();
      const result = await review(h, {
        runId: "RUN-BEFORE", signal: controller.signal,
        onPhase: (phase) => { if (phase === "setup") controller.abort(); },
        run: async () => assert.fail("an aborted lane must not start a lint child"),
      });
      assertLaneAborted(h, result, "RUN-BEFORE");
    } finally { h.cleanup(); }
  });
  await t.test("aborted while the lint child runs", async () => {
    const h = harness();
    try {
      const controller = new AbortController();
      let started = false;
      const result = await review(h, { runId: "RUN-DURING", signal: controller.signal,
        run: waitingChild(() => { started = true; setImmediate(() => controller.abort()); }) });
      assert.equal(started, true, "the lint child was running when the lane aborted");
      assertLaneAborted(h, result, "RUN-DURING");
    } finally { h.cleanup(); }
  });
  await t.test("the restart drain abandons the review while its lint child runs (#18803)", async () => {
    const h = harness();
    try {
      let childStarted!: () => void;
      const started = new Promise<void>((resolve) => { childStarted = resolve; });
      let result: Awaited<ReturnType<typeof review>> | undefined;
      const work = trackInFlightReview(async () => {
        result = await review(h, { runId: "RUN-DRAIN", run: waitingChild(() => childStarted()) });
      });
      await Promise.race([started, work.then(() => assert.fail("the review ended before its lint child started"))]);
      assert.equal(await drainInFlightReviews({ boundMs: 0, closeRefills: false }), 1);
      await work;
      assert.ok(result);
      assertLaneAborted(h, result, "RUN-DRAIN");
    } finally { h.cleanup(); }
  });
});

test("W1-T13151 criterion 2: exact reuse refuses a prior plan-only verdict whose plan lint did not run", async (t) => {
  // The #18803 decision_verdict as the 05:25:09Z review.posted row recorded it: all 3 criteria met, lint aborted.
  const criteria = [1, 2, 3].map((n) => ({ claim: `criterion ${n}`, proof: `grep: c${n} ${SHARD}`, met: true, floorMet: true,
    reason: "proof passed", proof_exec: "executed_pass" }));
  const aborted18803 = {
    state: "failure", criteria, testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: true,
    planLint: { ran: false, reason: "lint-plan aborted" },
    summary: `${WITHHELD}: lint-plan aborted`,
  } as unknown as ReviewVerdict;
  const run = async (verdict: ReviewVerdict) => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13151-reuse-`));
    const ledgerPath = join(root, "ledger.ndjson");
    const shim = ghShim([
      { when: "/statuses?", stdout: "[[]]" },
      { when: `pulls/${PR_NUMBER}`, stdout: '{"state":"open","merged":false}' },
      { when: "pr diff", stdout: DIFF },
    ], { kind: "t13151-reuse" });
    const priorPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
    const steps: Array<{ step: string; fields: Record<string, unknown> }> = [];
    try {
      appendLedger(ledgerPath, { run_id: "prior", task_id: `PR-${PR_NUMBER}`, step: "review.posted", state: verdict.state,
        head_sha: HEAD_SHA, pr_url: PR_URL, decision_verdict: verdict, reviewer_code_sha: "c".repeat(40) });
      const effects = buildSweepEffects({
        owner: "acme", repo: "remudero", localRepoName: "not-remudero", config: { root } as never, ledgerPath, runId: "t13151-reuse",
        plan: { tasks: [], byId: new Map() } as never,
        log: (step, fields) => steps.push({ step, fields: (fields ?? {}) as Record<string, unknown> }),
        reviewerCodeFreshnessImpl: () => ({ status: "fresh" as const, codeSha: "c".repeat(40), originMainSha: "c".repeat(40), advance: "none" as const }),
        reviewRunner: async () => { steps.push({ step: "full-review", fields: {} }); return 0; },
        materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
        buildBaseProofDirImpl: () => ({ baseCheckoutDir: "/base", baseUnreadablePaths: new Set<string>(), baseIsCheckout: true, addedTestFiles: new Set<string>() }),
        worktreeRemoveImpl: () => {},
      });
      const pr = {
        prNumber: PR_NUMBER, prUrl: PR_URL, isPlanFiling: true, reviewState: "none", checksState: "green", unmetCriteria: [],
        priorStrikes: 0, lastActivityAt: "2026-11-16T07:36:00Z", headSha: NEXT_HEAD, autoMergeArmed: false, body: BODY,
        currentOwnDiffDigest: "sha256:current", currentMergeBaseSha: "base-current",
      } as OpenPrView & Partial<ReviewReuseInputs>;
      await withLiveWritesAllowed(() => effects.postReview!(pr, { kind: "reuse", judgedHeadSha: HEAD_SHA }));
      return {
        steps,
        fallbacks: steps.filter((s) => s.step === "sweep.review_reuse_discrimination_fallback").map((s) => s.fields),
        reused: readLedgerLines(ledgerPath).filter((row) => row.step === "review.posted" && row.effective_review_mode === "verdict-reuse"),
      };
    } finally {
      process.env.PATH = priorPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(shim.dir, { recursive: true, force: true });
    }
  };
  await t.test("the #18803 verdict runs a full review instead", async () => {
    const out = await run(aborted18803);
    assert.equal(out.reused.length, 0, `no verdict-reuse review.posted row: ${JSON.stringify(out.reused)}`);
    assert.equal(out.fallbacks.length, 1);
    assert.equal(out.fallbacks[0]!.requested_review_mode, "reuse");
    assert.equal(out.fallbacks[0]!.effective_review_mode, "full-review");
    assert.equal(out.fallbacks[0]!.fallback_reason, "prior-plan-lint-did-not-run: lint-plan aborted");
    assert.equal(out.steps.some((s) => s.step === "full-review"), true, "the full review runs");
  });
  await t.test("a plan-only verdict with no recorded plan lint is not carried forward either", async () => {
    const { planLint: _dropped, ...noLint } = aborted18803;
    const out = await run(noLint as ReviewVerdict);
    assert.equal(out.reused.length, 0);
    assert.equal(out.fallbacks[0]?.fallback_reason, "prior-plan-lint-did-not-run: no plan lint recorded");
  });
  await t.test("CONTROL: a plan-only verdict whose lint ran is still reused", async () => {
    const out = await run({ ...aborted18803, state: "success", planLint: CLEAN_LINT, summary: "plan-only PASS" } as ReviewVerdict);
    assert.deepEqual(out.fallbacks, []);
    assert.equal(out.reused.length, 1, "the exact reuse path still re-posts a verdict its lint backs");
  });
});

test("W1-T13151 criterion 3: a plan lint that could not run for another reason still posts the withheld FAILURE", async (t) => {
  const cases: Array<[string, LintRun, RegExp]> = [
    ["a spawn error", async () => ({ status: null, signal: null, stdout: "", stderr: "", error: new Error("spawn EACCES") }),
      /lint-plan could not start: spawn EACCES/],
    ["a kill by signal", async () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }), /lint-plan killed by SIGKILL/],
    ["an exit with no summary", async () => ({ status: 0, signal: null, stdout: "incomplete lint\n", stderr: "" }), /no summary/],
  ];
  for (const [name, run, reason] of cases) {
    await t.test(name, async () => {
      const h = harness();
      try {
        const controller = new AbortController();
        const result = await review(h, { runId: `RUN-${name}`, signal: controller.signal, run });
        assert.equal(controller.signal.aborted, false, "the lane signal is live");
        assert.equal(result.planLint?.ran, false);
        assert.match(result.planLint && !result.planLint.ran ? result.planLint.reason : "", reason);
        assert.equal(result.planLint && !result.planLint.ran ? result.planLint.aborted : "ran", undefined, "only the lane abort marks aborted");
        assert.equal(result.state, "failure");
        assert.deepEqual(h.statusPosts().filter((state) => state !== "pending"), ["failure"], "a binding FAILURE is posted");
        assert.ok(h.descriptions().some((d) => d.includes(WITHHELD)), `the posted text names the withheld PASS: ${h.descriptions().join(" | ")}`);
        const posted = h.rows().filter((row) => row.step === "review.posted");
        assert.equal(posted.length, 1);
        assert.ok(String((posted[0]!.decision_verdict as ReviewVerdict).summary).includes(WITHHELD));
        assert.equal(h.rows().filter((row) => row.step === REVIEW_LANE_ABORTED_STEP).length, 0, "no lane-aborted row");
      } finally { h.cleanup(); }
    });
  }
});

test("W1-T13151 criterion 4: after a review.lane_aborted row the next sweep pass reviews the head again and posts", async () => {
  const h = harness();
  try {
    const controller = new AbortController();
    const first = await review(h, { runId: "RUN-ABORTED", signal: controller.signal,
      run: waitingChild(() => setImmediate(() => controller.abort())) });
    assertLaneAborted(h, first, "RUN-ABORTED");
    const now = Date.now();
    const pendingStatus = { id: 1, context: "remudero-review", state: "pending",
      description: "remudero-review: review in progress (owned by run RUN-ABORTED)", created_at: new Date(now - 60_000).toISOString() };
    // The drain precedes the daemon's restart, so the pending status's owner process is gone on the next pass.
    const readView = () => buildOpenPrViews("acme", "remudero", h.ledgerPath, {
      requiredContexts: () => ["ci-gate"],
      assessPendingOwner: (record) => { assert.equal(record.runId, "RUN-ABORTED"); return "dead"; },
      fetch: (args) => {
        const path = args.at(-1)!;
        if (path.includes("state=open")) return [{
          number: PR_NUMBER, html_url: PR_URL, head: { ref: `run-${TASK_ID}-1`, sha: HEAD_SHA },
          updated_at: new Date(now).toISOString(), body: BODY, auto_merge: null, state: "open",
        }];
        if (path.includes("check-runs")) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
        if (path.endsWith("/status")) return { statuses: [pendingStatus] };
        if (path.includes("/statuses?")) return [pendingStatus];
        if (path.endsWith(`/pulls/${PR_NUMBER}`)) return { mergeable: true, mergeable_state: "clean" };
        return [];
      },
    })[0];
    const view = readView();
    assert.ok(view);
    assert.equal(view.reviewState, "pending", "the aborted review left its pending status standing");
    assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, now).disposition, "post-review");
    let second: Awaited<ReturnType<typeof review>> | undefined;
    const deps: SweepDeps = {
      ledgerPath: h.ledgerPath, runId: "sweep-t13151", now: () => Date.now(),
      arm: () => {}, close: () => {}, dispatchFix: () => {},
      escalate: () => { assert.fail("an aborted review needs no escalation"); },
      rereadPrAtAct: readView,
      postReview: async () => { second = await review(h, { runId: "RUN-AGAIN", lint: CLEAN_LINT }); },
    };
    await runSweep([view], deps, DEFAULT_SWEEP_POLICY);
    const admitted = h.rows().filter((row) => row.step === "sweep.review_admitted");
    assert.equal(admitted.length, 1, "the sweep admits the review of the same PR and head again");
    assert.equal(admitted[0]!.head_sha, HEAD_SHA);
    assert.ok(second, "the admitted review ran");
    assert.equal(second.state, "success");
    assert.deepEqual(h.statusPosts().filter((state) => state !== "pending"), ["success"], "that review posts its verdict");
    const posted = h.rows().filter((row) => row.step === "review.posted");
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.run_id, "RUN-AGAIN");
    assert.equal(posted[0]!.head_sha, HEAD_SHA);
  } finally { h.cleanup(); }
});
