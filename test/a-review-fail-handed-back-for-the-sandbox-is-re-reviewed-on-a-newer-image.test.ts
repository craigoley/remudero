import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { runReview } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import {
  REVIEW_REQUEUED_STEP, REVIEWER_IMAGE_CHANGED, readRuntimeImageSha, reviewerImageDecisionDigest, runSweep,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

// W1-T9970 — #12409 and #12411: their proofs spawned python3, which the reviewer image lacked. The fix lane handed the
// head back, #12431 shipped python3 in image 895d73f, and nothing re-reviewed the unchanged heads.
const MIN = 60_000;
const NOW = Date.parse("2026-10-17T01:30:00Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * MIN).toISOString();
const PR_URL = "https://github.com/acme/remudero/pull/12409";
const HEAD = "e7926e54aa11bb22cc33dd44ee55ff6677889900";
const OLD_IMAGE = "a8f760d76".padEnd(40, "0");
const NEW_IMAGE = "895d73f2af93d2cdbc92cf261f1aabcea14aa1ad";

const failure = (minutesAgo: number, image?: string): Record<string, unknown> => ({
  ts: at(minutesAgo), task_id: "PR-12409", step: "review.posted", pr_url: PR_URL, head_sha: HEAD, state: "failure",
  unmet_criteria: ["the semgrep build runs"], ...(image !== undefined ? { runtime_image_sha: image } : {}),
});
const needsDesign = (minutesAgo: number): Record<string, unknown> => ({
  ts: at(minutesAgo), task_id: "PR-12409", step: "fix.needs_design", head_sha: HEAD,
  reason: "Both proofs spawn python3, which is missing in the reviewer sandbox (ENOENT before any assertion)",
});

const openPr = (): OpenPrView => ({
  prNumber: 12409, prUrl: PR_URL, headSha: HEAD, headRefName: "codex/semgrep-source-build-20261016",
  checksState: "green", reviewState: "failure", unmetCriteria: [{ claim: "the semgrep build runs", proof: "unit test: semgrep source build runs", met: false,
    reason: "python3: ENOENT", proof_exec: "executed_fail" }], priorStrikes: 1,
  autoMergeArmed: false, lastActivityAt: at(200), ciFailures: [],
});

function harness(rows: Record<string, unknown>[], image: string | undefined) {
  const effects: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/reviewer-image-ledger", runId: "reviewer-image", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    runtimeImageSha: () => image,
    dispatchFix: () => { effects.push("fix"); },
    dispatchPlanOnlyRepair: () => { effects.push("plan"); return true; },
    postReview: (pr) => { effects.push(`review:${pr.prNumber}`); },
    arm: () => { effects.push("arm"); return "armed"; },
    escalate: (_pr, reason) => { effects.push(`escalate:${reason}`); },
    close: () => { effects.push("close"); },
  };
  return { rows, effects, deps };
}

const requeues = (rows: Record<string, unknown>[]) => rows.filter((row) => row.step === REVIEW_REQUEUED_STEP);

test("W1-T9970: a handed-back review failure is re-reviewed on a newer reviewer image", async () => {
  const h = harness([failure(330, OLD_IMAGE), needsDesign(293)], NEW_IMAGE);
  const action = (await runSweep([openPr()], h.deps)).actions[0]!;
  assert.equal(action.disposition, "post-review");
  assert.equal(action.acted, true);
  assert.match(action.reason, /re-reviewing the unchanged head once/);
  assert.deepEqual(h.effects, ["review:12409"], "one review of the same head, no fix round");
  const [row, ...more] = requeues(h.rows);
  assert.equal(more.length, 0);
  assert.equal(row!.reason, REVIEWER_IMAGE_CHANGED);
  assert.equal(row!.pr_number, 12409);
  assert.equal(row!.head_sha, HEAD);
  assert.equal(row!.old_image_sha, OLD_IMAGE);
  assert.equal(row!.new_image_sha, NEW_IMAGE);
  assert.deepEqual(row!.handoff, { step: "fix.needs_design", ts: at(293) });

  // #12411's shape: a failure recorded before runtime_image_sha existed, handed back by an unfiled-scope stand-down.
  const unfiled = harness([failure(224), { ts: at(144), task_id: "PR-12409", step: "fix.stood_down",
    site: "rung.unfiled_scope", head_sha: HEAD, reason: "unfiled scope need escalated" }], NEW_IMAGE);
  assert.equal((await runSweep([openPr()], unfiled.deps)).actions[0]!.disposition, "post-review");
  assert.equal(requeues(unfiled.rows)[0]!.old_image_sha, null, "an unrecorded image is unknown, never unchanged");

  // A fix report refusing the proof as unexecutable at this head is a hand-back too.
  const refused = harness([failure(224, OLD_IMAGE), { ts: at(100), task_id: "PR-12409", step: "fix.stood_down",
    site: "rung.other", head_sha: HEAD,
    report_excerpt: "REFUSED:\n  1. [proof-unexecutable-at-head] python3 is absent from the reviewer sandbox" }], NEW_IMAGE);
  assert.equal((await runSweep([openPr()], refused.deps)).actions[0]!.disposition, "post-review");
});

test("W1-T9970: the same image never re-reviews twice and an un-handed-back failure keeps its fix route", async () => {
  const h = harness([failure(330, OLD_IMAGE), needsDesign(293)], NEW_IMAGE);
  await runSweep([openPr()], h.deps);
  assert.equal(requeues(h.rows).length, 1);
  // The re-review has not landed yet: the request already names this head and image, so no second one.
  const again = await runSweep([openPr()], h.deps);
  assert.equal(requeues(h.rows).length, 1, "one re-review per (head, running image)");
  assert.notEqual(again.actions[0]!.reason.includes("re-reviewing the unchanged head"), true);
  // The re-review failed again on the new image. Its legacy hand-back lacks a bound round receipt;
  // W1-T9955 makes taskless PRs read that uncertainty just as task-keyed PRs do.
  h.rows.push(failure(1, NEW_IMAGE));
  const failedAgain = await runSweep([openPr()], { ...h.deps, readLedger: () => h.rows.filter((r) => r.step !== REVIEW_REQUEUED_STEP) });
  assert.equal(failedAgain.actions[0]!.disposition, "wait");
  assert.match(failedAgain.actions[0]!.reason, /terminal design handoff context unavailable/);
  assert.equal(failedAgain.actions[0]!.acted, false);
  assert.equal(h.effects.includes("fix"), false, "an unbound design hand-back cannot admit a fix");
  assert.equal(requeues(h.rows).length, 1, "the failure's own image is the running one");
  // A later image earns its own re-review.
  const later = harness([...h.rows], "c0ffee".padEnd(40, "1"));
  assert.equal((await runSweep([openPr()], later.deps)).actions[0]!.disposition, "post-review");
  assert.equal(requeues(later.rows).length, 2);

  // No hand-off: today's fix route, whatever image is running.
  const plain = harness([failure(330, OLD_IMAGE)], NEW_IMAGE);
  const plainAction = (await runSweep([openPr()], plain.deps)).actions[0]!;
  assert.equal(plainAction.disposition, "blocked-fixable");
  assert.deepEqual(requeues(plain.rows), []);
  assert.equal(plain.effects.includes("review:12409"), false);
  // An unknown running image (off-container) is never a change.
  const unknown = harness([failure(330, OLD_IMAGE), needsDesign(293)], undefined);
  const unknownAction = (await runSweep([openPr()], unknown.deps)).actions[0]!;
  assert.equal(unknownAction.disposition, "wait");
  assert.match(unknownAction.reason, /terminal design handoff context unavailable/);
  assert.equal(unknownAction.acted, false);
  assert.deepEqual(unknown.effects, []);
  assert.deepEqual(requeues(unknown.rows), []);
  // A hand-off at another head is not this head's.
  const otherHead = harness([failure(330, OLD_IMAGE), { ...needsDesign(293), head_sha: "f".repeat(40) }], NEW_IMAGE);
  assert.equal((await runSweep([openPr()], otherHead.deps)).actions[0]!.disposition, "blocked-fixable");
});

test("W1-T9970: the requested re-review is its own decision, and the reviewer image is read from the build stamp", () => {
  const digest = "v2:" + "d".repeat(64);
  const request = { step: REVIEW_REQUEUED_STEP, reason: REVIEWER_IMAGE_CHANGED, head_sha: HEAD, new_image_sha: NEW_IMAGE };
  const requested = reviewerImageDecisionDigest(digest, { headSha: HEAD, runtimeImageSha: NEW_IMAGE, requeues: [request] });
  assert.notEqual(requested, digest, "a replay of the old failure would make the re-review a no-op");
  assert.match(requested, /^v2:[0-9a-f]{64}$/);
  assert.equal(reviewerImageDecisionDigest(digest, { headSha: HEAD, runtimeImageSha: NEW_IMAGE, requeues: [] }), digest);
  assert.equal(reviewerImageDecisionDigest(digest, { headSha: HEAD, runtimeImageSha: OLD_IMAGE, requeues: [request] }), digest);
  assert.equal(reviewerImageDecisionDigest(digest, { headSha: HEAD, runtimeImageSha: undefined, requeues: [request] }), digest);

  const dir = mkdtempSync(join(tmpdir(), "rmd-t9970-"));
  try {
    const stamp = join(dir, "rmd-build-sha");
    writeFileSync(stamp, `${NEW_IMAGE}\n`);
    assert.equal(readRuntimeImageSha(stamp), NEW_IMAGE);
    writeFileSync(stamp, "\n");
    assert.equal(readRuntimeImageSha(stamp), undefined, "an empty stamp is unknown");
    assert.equal(readRuntimeImageSha(join(dir, "absent")), undefined, "off-container is unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9970: review.posted records the reviewer image, and a requested re-review computes instead of replaying", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9970-review-"));
  const oldPath = process.env.PATH;
  let shimDir: string | undefined;
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const github = ghShim([
      { when: "comments", stdout: "[]" }, { when: "reviews", stdout: "[]" },
      { when: "commits/", stdout: '{"statuses":[]}' },
      { when: "pulls/", stdout: JSON.stringify({ number: 12409, html_url: PR_URL, updated_at: "t", body: "", head: { ref: "b", sha: HEAD } }) },
      { when: "headRefOid", stdout: JSON.stringify({ headRefOid: HEAD }) },
      { when: "pr view", stdout: '{"state":"OPEN"}' }, { when: "pr diff", stdout: "" },
      { when: "api", stdout: "{}" },
    ]);
    shimDir = github.dir;
    process.env.PATH = `${github.dir}:${oldPath}`;
    const review = (image: string | null, ledger = ledgerPath) => runReview({
      owner: "acme", repo: "remudero", prUrl: PR_URL,
      task: { id: "PR-12409", acceptance: [{ claim: "the semgrep build runs", proof: "unit test: semgrep source build runs" }] },
      report: "the body", reviewInputBody: "the body", settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as never,
      log: (step: string, extra?: Record<string, unknown>) => appendLedger(ledger, { run_id: "T9970-REVIEW", task_id: "PR-12409", step, ...extra }),
      say: () => {}, account: (r: never) => r, spawnReviewer: false, disarm: () => {}, arm: () => {},
      ledgerPath: ledger, runId: "T9970-REVIEW", runtimeImageSha: image,
    } as never) as Promise<{ state: string; decisionDisposition?: string }>;
    const posted = () => readLedgerLines(ledgerPath).filter((line) => line.step === "review.posted");

    const first = await review(OLD_IMAGE);
    assert.equal(first.state, "failure");
    assert.equal(posted().length, 1);
    assert.equal(posted()[0]!.runtime_image_sha, OLD_IMAGE);
    // Unrequested, the same input replays its decision on any image.
    assert.equal((await review(NEW_IMAGE)).decisionDisposition, "replayed");
    assert.equal(posted().length, 1);

    appendLedger(ledgerPath, { run_id: "T9970-SWEEP", task_id: "PR-12409", step: REVIEW_REQUEUED_STEP, reason: REVIEWER_IMAGE_CHANGED,
      pr_number: 12409, head_sha: HEAD, old_image_sha: OLD_IMAGE, new_image_sha: NEW_IMAGE });
    const requested = await review(NEW_IMAGE);
    assert.equal(requested.decisionDisposition, "computed", "the re-review the sweep asked for runs");
    assert.equal(posted().length, 2);
    assert.equal(posted()[1]!.runtime_image_sha, NEW_IMAGE);
    assert.notEqual(posted()[1]!.review_decision_digest, posted()[0]!.review_decision_digest);
    assert.equal(readLedgerLines(ledgerPath).some((line) => line.step === "review.verdict_conflict"), false);

    // Off-container the row carries no image at all: absent, never a guessed value.
    mkdirSync(join(root, "off-container"));
    const offContainer = join(root, "off-container", "ledger.ndjson");
    await review(null, offContainer);
    const [offRow] = readLedgerLines(offContainer).filter((line) => line.step === "review.posted");
    assert.equal(offRow!.state, "failure");
    assert.equal("runtime_image_sha" in offRow!, false);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    if (shimDir !== undefined) rmSync(shimDir, { recursive: true, force: true });
  }
});
