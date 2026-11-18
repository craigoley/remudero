/**
 * W1-T13706 — a delivered review failure settles an open pull request's view that reads no review status.
 *
 * OBSERVED 2026-11-17 on #19199, head dcc5863f: the review failure was posted at 20:57:31Z. At 21:02:59Z a light pass,
 * deciding from a last good open-PR list, read no review status for the head and wrote post-review, "checks pending 23m,
 * review never posted". Its claim stood down: "a verdict was already DELIVERED". The fix round started 25 minutes after the
 * failure. Before this task only a view that read pending was settled from the delivered verdict (W1-T12994).
 *
 * Every stamp below is aged only against the clock each fixture injects, never the wall clock.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { Plan } from "#src/lib/plan.js";
import { REVIEWER_CODE_ADVANCED } from "#src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY, REVIEW_REQUEUED_STEP, REVIEWER_IMAGE_CHANGED, buildSweepEffects, deriveDisposition,
  pendingViewSettledFromDeliveredFailure, readLiveLedgerRows, reviewViewSettledFromDeliveredFailure, runSweep, runSweepLightPass,
  type OpenPrView, type ReviewDispatchMode, type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const at = (clock: string): string => `2026-11-17T${clock}.000Z`;

const TASK = "W1-T13010";
const PR_NUMBER = 19199;
const HEAD = "dcc5863f".padEnd(40, "d");
const DIGEST = "v2:dcc5863f";
const NOW = at("21:02:59");
const FAILED_AT = at("20:57:31");
const UNMET = "a light pass decides from its last good open-PR list";
const NO_PLAN = { tasks: [], byId: new Map() } as unknown as Plan;

function fixture(t: TestContext, view: Partial<OpenPrView> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13706-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const prUrl = `https://github.com/acme/scratch/pull/${PR_NUMBER}`;
  const key = `input:${JSON.stringify([TASK, prUrl, HEAD, DIGEST])}`;
  const now = Date.parse(NOW);
  // The view a last good open-PR list holds: read before the review's pending post, so it carries no review status.
  const pr: OpenPrView = {
    prNumber: PR_NUMBER, prUrl, taskId: TASK, headSha: HEAD, headRefName: `run-${TASK}-1795000000000`, reviewInputDigest: DIGEST,
    reviewState: "none", checksState: "pending", checksPendingSince: at("20:39:00"), unmetCriteria: [], priorStrikes: 0,
    autoMergeArmed: false, lastActivityAt: at("20:39:00"), ...view,
  };
  const modes: ReviewDispatchMode[] = [];
  const fixes: OpenPrView[] = [];
  const row = (step: string, ts: string, over: Record<string, unknown> = {}) => appendLedger(ledgerPath, {
    run_id: `review-PR${PR_NUMBER}-${ts}`, task_id: TASK, step, ts, pr_url: prUrl, head_sha: HEAD, review_input_digest: DIGEST, ...over,
  });
  const seed = {
    failure: (ts = FAILED_AT, over: Record<string, unknown> = {}) => row("review.posted", ts, { state: "failure",
      unmet_criteria: [UNMET], reasons: ["the proof printed no hit"], failure_class: "criteria_unmet",
      decision_verdict: { state: "failure", summary: "remudero-review: FAIL — 1 of 3 criteria unmet",
        criteria: [{ claim: UNMET, proof: "grep: x in y", met: false, reason: "the proof printed no hit", proof_exec: "executed_fail" }] },
      ...over }),
    success: (ts = FAILED_AT) => row("review.posted", ts, { state: "success", unmet_criteria: [], reasons: [],
      decision_verdict: { state: "success", summary: "remudero-review: PASS", criteria: [] } }),
    row,
  };
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t13706", now: () => now,
    arm: () => assert.fail("a head whose review failed is never armed"),
    close: () => assert.fail("unexpected close"), escalate: () => assert.fail("unexpected escalation"),
    dispatchFix: (failed) => { fixes.push(failed); },
    postReview: (_pr, mode = { kind: "full-review" }) => { modes.push(mode); },
  };
  const lines = () => readLiveLedgerRows(ledgerPath);
  const rows = (step: string) => lines().filter(r => r.step === step);
  const run = async (over: Partial<OpenPrView> = {}) => {
    await runSweep([{ ...pr, ...over }], deps, DEFAULT_SWEEP_POLICY);
    const disposed = rows("sweep.disposed").at(-1);
    assert.ok(disposed, "the pass disposed the pull request");
    return disposed;
  };
  return { pr, key, ledgerPath, now, deps, seed, modes, fixes, rows, run, lines };
}

/** The view the producer builds once GitHub's status reads the delivered failure. */
function failedView(pr: OpenPrView): OpenPrView {
  return { ...pr, reviewState: "failure",
    unmetCriteria: [{ claim: UNMET, proof: "grep: x in y", met: false, reason: "the proof printed no hit", proof_exec: "executed_fail" }] };
}

test("W1-T13706 criterion 1: a delivered failure settles a view that reads no review status — a failed review's disposition, no review", async t => {
  const f = fixture(t);
  f.seed.failure();
  const failed = deriveDisposition(failedView(f.pr), DEFAULT_SWEEP_POLICY, f.now);
  assert.equal(failed.disposition, "blocked-fixable", "what a failed review with an unmet criterion takes");
  const disposed = await f.run();
  assert.equal(disposed.disposition, failed.disposition, JSON.stringify(disposed));
  assert.equal(disposed.blocker, "review-failed", JSON.stringify(disposed));
  assert.equal(disposed.acted, true, JSON.stringify(disposed));
  assert.notEqual(disposed.deduped, true);
  assert.doesNotMatch(String(disposed.reason), /review never posted/);
  assert.equal(disposed.review_view_settled, "verdict-without-status");
  assert.equal(disposed.review_view_settled_at, FAILED_AT);
  assert.equal(f.fixes.length, 1, "the fix lane was dispatched");
  assert.equal(f.fixes[0]?.reviewState, "failure");
  assert.deepEqual(f.fixes[0]?.unmetCriteria.map(c => [c.claim, c.met, c.reason, c.proof_exec]),
    [[UNMET, false, "the proof printed no hit", "executed_fail"]]);
  assert.deepEqual(f.modes, [], "no review was started for the input");
  assert.equal(f.rows("sweep.review_admitted").length, 0);

  const settled = reviewViewSettledFromDeliveredFailure(f.pr, true, f.lines(), f.key);
  assert.equal(settled?.basis, "verdict-without-status");
  assert.equal(settled?.view.reviewState, "failure");
  assert.equal(settled?.view.reviewSummary, "remudero-review: FAIL — 1 of 3 criteria unmet");
});

test("W1-T13706 criterion 2: on the light pass's production path a view that reads none reaches dispatchFix once and names its settle", async t => {
  const f = fixture(t);
  f.seed.failure();
  const effects = buildSweepEffects({
    owner: "acme", repo: "scratch", config: { root: join(f.ledgerPath, "..") } as Config, ledgerPath: f.ledgerPath,
    runId: f.deps.runId, nowMsImpl: () => f.now, plan: NO_PLAN, log: () => {},
    // GitHub: the head is open and unmoved. No other read is answered.
    ghLiveStateImpl: async () => ({ ok: true, state: "OPEN", headSha: HEAD }),
    readJsonImpl: async (args: string[]) => { throw new Error(`no GitHub read in this test: ${args.join(" ")}`); },
    ghJsonImpl: (args: string[]) => {
      if (args.join(" ") === `api repos/acme/scratch/pulls/${PR_NUMBER}`) {
        return { user: { login: "remudero-bot" }, title: "fix(sweep): a light pass", head: { sha: HEAD, ref: f.pr.headRefName } };
      }
      throw new Error(`no GitHub read in this test: ${args.join(" ")}`);
    },
    issuesImpl: { create: () => assert.fail("no escalation is filed"), listOpen: () => [] },
    reviewRunner: async () => assert.fail("no review is started for a delivered failure"),
    armImpl: () => assert.fail("a failed head is never armed"),
  });
  // The worker spawn: the fix round the real dispatch would start.
  const deps: SweepDeps = { ...effects, ledgerPath: f.ledgerPath, runId: f.deps.runId, now: () => f.now,
    dispatchFix: (failed) => { f.fixes.push(failed); } };
  await runSweepLightPass([f.pr], deps, DEFAULT_SWEEP_POLICY);
  const disposed = f.rows("sweep.disposed").filter(r => r.pr_number === PR_NUMBER);
  assert.equal(f.fixes.length, 1, `the fix lane was dispatched once: ${JSON.stringify(disposed)}`);
  assert.equal(f.fixes[0]?.headSha, HEAD);
  assert.equal(f.fixes[0]?.reviewState, "failure");
  const last = disposed.at(-1);
  assert.equal(last?.disposition, "blocked-fixable", JSON.stringify(last));
  assert.equal(last?.acted, true, JSON.stringify(last));
  assert.equal(last?.review_view_settled, "verdict-without-status");
  assert.notEqual(last?.review_view_settled, "verdict-after-pending");
  assert.equal(last?.review_view_settled_at, FAILED_AT);
  assert.equal(f.rows("sweep.review_admitted").length, 0, "no review was admitted");
});

test("W1-T13706 criterion 3: invariant:settle-only-on-a-delivered-failure — a view that reads none keeps origin/main's disposition", async t => {
  const otherHead = "0ldhead0".padEnd(40, "0");
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void, Partial<OpenPrView>?]> = [
    ["no delivered verdict", () => {}],
    ["a delivered success", f => f.seed.success()],
    ["a cannot-evaluate failure", f => f.seed.failure(FAILED_AT, { decision_verdict: { state: "failure", cannotEvaluate: true,
      summary: "remudero-review: cannot-evaluate", criteria: [] } })],
    ["a cannot-evaluate hold", f => f.seed.row("review.posted", FAILED_AT, { state: "pending",
      decision_verdict: { state: "pending", cannotEvaluate: true, summary: "hold", criteria: [] } })],
    ["a failure with no unmet criterion", f => f.seed.failure(FAILED_AT, { unmet_criteria: [] })],
    ["an instrument-entangled failure", f => f.seed.failure(FAILED_AT, { failure_class: "instrument_entangled", instrument_entangled: true })],
    ["a failure the newer success replaced", f => { f.seed.failure(at("20:50:00")); f.seed.success(); }],
    ["a reviewer-code requeue after the verdict", f => { f.seed.failure(); f.seed.row(REVIEW_REQUEUED_STEP, at("20:59:00"),
      { reason: REVIEWER_CODE_ADVANCED, pr_number: PR_NUMBER, review_key: f.key }); }],
    ["a reviewer-image requeue after the verdict", f => { f.seed.failure(); f.seed.row(REVIEW_REQUEUED_STEP, at("20:59:00"),
      { reason: REVIEWER_IMAGE_CHANGED, pr_number: PR_NUMBER, review_key: f.key, new_image_sha: "image-b" }); }],
    ["a failure for an older head", f => f.seed.failure(FAILED_AT, { head_sha: otherHead })],
    ["a failure for another review input", f => f.seed.failure(FAILED_AT, { review_input_digest: "v2:other" })],
    ["an unread rollup", f => f.seed.failure(), { rollupUnreadable: true }],
  ];
  for (const [label, seed, view] of cases) {
    // origin/main's disposition: the same view and ledger with no settle at all.
    const control = fixture(t, view);
    seed(control);
    const expected = deriveDisposition(control.pr, DEFAULT_SWEEP_POLICY, control.now);
    assert.notEqual(expected.disposition, "blocked-fixable", label);
    const f = fixture(t, view);
    seed(f);
    assert.equal(reviewViewSettledFromDeliveredFailure(f.pr, true, f.lines(), f.key)?.basis,
      label.includes("requeue") ? "verdict-without-status" : undefined, `${label}: the ledger alone settles only a released failure`);
    const disposed = await f.run();
    assert.equal(disposed.disposition, expected.disposition, `${label}: ${JSON.stringify(disposed)}`);
    assert.equal(Object.hasOwn(disposed, "review_view_settled"), false, `${label}: ${JSON.stringify(disposed)}`);
    assert.equal(f.fixes.length, 0, `${label}: no fix round`);
  }

  // Nothing changes for a view that reads pending, success or failure.
  const f = fixture(t, { reviewPendingSince: at("20:53:35") });
  f.seed.failure();
  for (const state of ["pending", "success", "failure"] as const) {
    const view = { ...f.pr, reviewState: state };
    for (const delivered of [true, false]) {
      assert.deepEqual(reviewViewSettledFromDeliveredFailure(view, delivered, f.lines(), f.key),
        pendingViewSettledFromDeliveredFailure(view, delivered, f.lines(), f.key), `${state}, delivered ${delivered}`);
    }
  }
  assert.equal(reviewViewSettledFromDeliveredFailure({ ...f.pr, reviewState: "pending" }, true, f.lines(), f.key)?.basis,
    "verdict-after-pending");
  assert.equal(reviewViewSettledFromDeliveredFailure(f.pr, false, f.lines(), f.key), undefined, "a released key is no standing verdict");
});
