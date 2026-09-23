// W1-T2443 — OPERATOR RULING 2026-09-22 (Q1: YES, and further). At #3219 a same-sha `remudero-review`
// FAILURE was correctly deduped thirteen consecutive times by the post-review action gate, which
// keys on `taskId@headSha` — a body repair does not earn a new key, so the corrected input stayed
// permanently unjudgeable until an operator ran `rmd review` by hand. The ruling: RE-KEY the dedup
// on a digest of the review INPUT (head sha + body), so a repaired body is a NEW input the gate
// re-offers on its own, while an unchanged body at the same sha stays suppressed forever — the
// safety property the dedup exists for.
//
// AT THIS BASE, `reviewOutcomeKeyForPr` (src/lib/sweep.ts) already composes
// `reviewOutcomeKey(taskId, pr.prUrl, pr.headSha, pr.reviewInputDigest)`, and `reviewInputDigest`
// (src/lib/review.ts) already hashes `{ headSha, body, engineRevision }` — landed by #3568/#3604/
// #4029/#6192, after this shard was filed and before the ruling. These four tests are this shard's
// own four acceptance proofs, each driven end-to-end through `runSweep` against the EXACT shape the
// incident hit (checks green, a posted FAILURE, a same-sha body repair, zero hand-run verbs) so the
// composition the incident actually exercised is what stays pinned, not merely the primitive.
//
// COMPANIONS, NOT DUPLICATES: `review-body-edit-reoffer.test.ts` drives row 3.6's ADMITTING arm
// (`reviewVerdictOvertakenByActivity` + `deriveDisposition`) in isolation; `post-review-refusal-
// rearm.test.ts` drives the dedup KEY reset off a bare `reviewState:"none"` fixture. Neither drives
// both layers together against a posted-FAILURE, same-sha, checks-green fixture — the shape that
// left #3219 stuck for thirteen cycles — which is the gap this file closes.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewInputDigest } from "../src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  reviewVerdictOvertakenByActivity,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── the incident's own shape, reused across all four tests ──────────────────────────────────────

const NOW = Date.parse("2026-08-28T13:37:00.000Z"); // inside the incident's own 13:23–13:36 window
const HEAD = "2ba669fb2ba669fb2ba669fb2ba669fb2ba669fb"; // the incident's own sha, padded to 40 hex
const PR_URL = "https://github.com/craigoley/remudero/pull/3219";
const TASK_ID = "W1-T2428"; // the incident's own task id
const OLD_BODY = "a claim phrased with an attributive scope shorthand about the changeset";
const NEW_BODY = "the same claim, repaired to drop the changeset-scope shorthand";
const VERDICT_AT = "2026-08-28T13:12:18.610Z"; // the incident's own review.posted timestamp
const REPAIR_AT = "2026-08-28T13:32:24.000Z"; // the incident's own body-PATCH timestamp

const OLD_DIGEST = reviewInputDigest(HEAD, OLD_BODY);
const NEW_DIGEST = reviewInputDigest(HEAD, NEW_BODY);

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-repaired-body-")), "ledger.ndjson");
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: overrides.ledgerPath ?? ledgerPath(),
    runId: "SWEEP-2443",
    now: () => NOW,
    ...overrides,
  };
}

/** The incident's own PR shape at the incident's own sha: checks green, `remudero-review` FAILURE,
 *  a verdict already posted, and activity (the body PATCH) after it. `digest`/`attempts` are the
 *  only fields that differ between an unchanged and a repaired body — everything else, including
 *  `headSha`, is held byte-identical, because the ruling's whole point is that the SHA NEVER CHANGES. */
function samePrAtSameSha(digest: string, attempts: number): OpenPrView {
  return {
    prNumber: 3219,
    prUrl: PR_URL,
    taskId: TASK_ID,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    criteriaRecoverable: false,
    priorStrikes: 0,
    priorReviewAttemptsForInput: attempts,
    reviewInputDigest: digest,
    reviewVerdictPostedAt: VERDICT_AT,
    lastActivityAt: REPAIR_AT,
    headSha: HEAD,
    autoMergeArmed: false,
  };
}

function deliverOldVerdict(lp: string): void {
  appendLedger(lp, {
    run_id: "SWEEP-OLD",
    task_id: TASK_ID,
    step: "review.posted",
    pr_url: PR_URL,
    head_sha: HEAD,
    review_input_digest: OLD_DIGEST,
    state: "failure",
  });
}

// ── acceptance 1 — a repaired body is a NEW input, not a suppressed re-post ─────────────────────

test("a repaired body is a new review input — claim 1: the post-review dedup key includes a digest of the PR body, so a repaired body is a NEW input rather than a suppressed re-post", async () => {
  assert.notEqual(OLD_DIGEST, NEW_DIGEST, "a body edit changes the digest at an unchanged sha");

  const lp = ledgerPath();
  deliverOldVerdict(lp); // exactly what thirteen sweep cycles read as `alreadyDone` at #3219

  const calls: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.prNumber);
    },
  });

  // priorReviewAttemptsForInput=0 is what a real `buildOpenPrViews` computes for NEW_DIGEST: the
  // ledger's only review.posted row is keyed to OLD_DIGEST, so it does not count against it.
  const summary = await runSweep([samePrAtSameSha(NEW_DIGEST, 0)], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(calls, [3219], "the repaired body reaches the post-review lane on the FIRST sweep pass — no hand-run `rmd review` anywhere in this test");
  assert.equal(summary.byDisposition["post-review"], 1);
});

// ── acceptance 2 — an unchanged body on the same head is still deduped forever ──────────────────

test("an unchanged body is still suppressed forever — claim 2: an UNCHANGED body on the same head is still deduped forever, so the stand-down that makes an unattended fleet tractable is preserved", async () => {
  const lp = ledgerPath();
  deliverOldVerdict(lp);

  const calls: number[] = [];
  const deps1 = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.prNumber);
    },
  });
  // Same digest as the delivered verdict — an unchanged body, still at the same sha.
  await runSweep([samePrAtSameSha(OLD_DIGEST, 1)], deps1, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 0, "the unchanged input is deduped on the very next pass");

  // Thirteen more passes, exactly the incident's own count, with no clock bound on the dedup.
  for (let i = 0; i < 13; i++) {
    const again = fakeDeps({
      ledgerPath: lp,
      now: () => NOW + i * 70_000, // ~70s apart, the incident's own cadence
      postReview: (p) => {
        calls.push(p.prNumber);
      },
    });
    await runSweep([samePrAtSameSha(OLD_DIGEST, 1)], again, DEFAULT_SWEEP_POLICY);
  }
  assert.deepEqual(calls, [], "an unchanged body stays suppressed forever — never re-posted, exactly as at #3219");
});

// ── acceptance 3 — row 3.6 is reachable on its own stated case, with no hand-run verb ────────────

test("a body repair on an unchanged sha reaches the reviewer — claim 3: row 3.6 (VERDICT OVERTAKEN BY ACTIVITY) is reachable on its own stated case — a body repair on an unchanged sha now reaches the reviewer without a hand-run verb", async () => {
  // The disposition layer: reviewVerdictOvertakenByActivity + zero exact-input attempts admits the
  // head to `post-review` — the SAME arm #3219 needed and never got dispatched by the sweep alone.
  assert.equal(reviewVerdictOvertakenByActivity(samePrAtSameSha(NEW_DIGEST, 0)), true, "the body PATCH is activity after the posted verdict");
  const admitted = deriveDisposition(samePrAtSameSha(NEW_DIGEST, 0), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(admitted.disposition, "post-review");
  assert.match(admitted.reason, /activity since that verdict was posted/);

  // The action-gate layer: with the re-keyed dedup, that admission is not thrown away again — no
  // `rmd review <n>` is invoked anywhere in this test, only `runSweep` itself.
  const lp = ledgerPath();
  deliverOldVerdict(lp);
  const calls: number[] = [];
  const deps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.prNumber);
      // Simulates the real effect posting a FRESH verdict for the repaired input — never a
      // carried-forward one (the reviewer "keeps its teeth", W1-T2299's own framing).
      appendLedger(lp, {
        run_id: "SWEEP-2443",
        task_id: p.taskId ?? "",
        step: "review.posted",
        pr_url: p.prUrl,
        head_sha: p.headSha,
        review_input_digest: p.reviewInputDigest,
        state: "success",
      });
    },
  });
  await runSweep([samePrAtSameSha(NEW_DIGEST, 0)], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls, [3219], "the repaired input at the SAME sha reaches the reviewer on the sweep's own next pass");

  // And a SECOND pass, with the fresh verdict now ledgered, dedupes the repaired input exactly like
  // any other delivered verdict — the escape hatch's clearing did not weaken the stand-down.
  calls.length = 0;
  const deps2 = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      calls.push(p.prNumber);
    },
  });
  await runSweep([samePrAtSameSha(NEW_DIGEST, 1)], deps2, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(calls, [], "the repaired input's own fresh verdict now dedupes it too, once delivered");
});

// ── acceptance 4 — re-keying adds no bypass; the same deterministic judge still runs ─────────────

test("re-keying does not add a bypass — claim 4: the change re-keys the dedup and does not weaken, bypass or remove the escape hatch, which still invokes the same deterministic judge", async () => {
  // (a) No unconditional bypass: a repaired-body digest at RED checks is not admitted to
  // post-review at all — re-keying only changes WHICH input the gate compares, not the surrounding
  // guards every other candidate must still clear.
  const redChecks = { ...samePrAtSameSha(NEW_DIGEST, 0), checksState: "red" as const };
  assert.notEqual(deriveDisposition(redChecks, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review", "checks-red still blocks admission — the digest alone grants nothing");

  // (b) No special-cased dispatch path: the SAME `deps.postReview` lane every other post-review
  // admit takes is what runs for a repaired-body admit too — no second, bypassing effector.
  const lp = ledgerPath();
  deliverOldVerdict(lp);
  const freshCalls: OpenPrView[] = [];
  const repairedCalls: OpenPrView[] = [];
  const freshDeps = fakeDeps({
    ledgerPath: ledgerPath(),
    postReview: (p) => {
      freshCalls.push(p);
    },
  });
  const repairedDeps = fakeDeps({
    ledgerPath: lp,
    postReview: (p) => {
      repairedCalls.push(p);
    },
  });
  await runSweep(
    [{ ...samePrAtSameSha(NEW_DIGEST, 0), prNumber: 1, prUrl: "https://github.com/o/r/pull/1", taskId: "W1-FRESH", reviewState: "none" as const, reviewVerdictPostedAt: undefined }],
    freshDeps,
    DEFAULT_SWEEP_POLICY,
  );
  await runSweep([samePrAtSameSha(NEW_DIGEST, 0)], repairedDeps, DEFAULT_SWEEP_POLICY);
  assert.equal(freshCalls.length, 1, "an ordinary never-reviewed PR is dispatched through postReview");
  assert.equal(repairedCalls.length, 1, "a repaired-body PR is dispatched through the SAME postReview dependency — no second lane");

  // (c) The old body's own key is untouched by the repair: re-keying is additive (headSha AND body
  // digest), never a replacement that could accidentally forgive the old, still-failing input.
  const lp2 = ledgerPath();
  deliverOldVerdict(lp2);
  const oldBodyCalls: number[] = [];
  await runSweep(
    [samePrAtSameSha(OLD_DIGEST, 1)],
    fakeDeps({
      ledgerPath: lp2,
      postReview: (p) => {
        oldBodyCalls.push(p.prNumber);
      },
    }),
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(oldBodyCalls, [], "the old, already-judged input stays suppressed — re-keying never re-opens what it was not asked to");
});
