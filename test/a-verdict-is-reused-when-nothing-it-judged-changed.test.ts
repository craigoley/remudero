/**
 * test/a-verdict-is-reused-when-nothing-it-judged-changed.test.ts — W1-T3704.
 *
 * THE DEFECT: a push discards a completed review WHOLE, even when the pull request's own diff is
 * byte-identical. `DISPOSITION_RULES` (src/lib/sweep.ts) routed EVERY `reviewOrphanedByPush` PR to
 * either the W1-T225 escalation cap or a full `post-review` re-review — no cheaper middle case for
 * the common "update branch" / no-op-force-push shapes.
 *
 * THE FIX, split exactly along the task's own design boundary:
 *  (i)   review.ts RECORDS what a verdict judged: `reviewLedgerLegibilityFields` rides `own_diff_digest`/
 *        `merge_base_sha` onto the `review.posted` ledger line when the verdict carries them, and
 *        `priorReviewVerdictFromLedger` reads them back onto {@link PriorReviewVerdict} — absent
 *        means UNREADABLE, never a false-ish default (unlike `capped`/`planOnly`).
 *  (ii)  sweep.ts DECIDES what a later push, having orphaned that verdict, is actually owed:
 *        {@link reviewReuseVerdict} compares what was judged against what the current push carries
 *        and returns `"reuse"` / `"discriminate-only"` / `"full-review"`. Two new `DISPOSITION_RULES`
 *        rows route the first two kinds to the `"review-reused"`/`"discriminate-only"` dispositions,
 *        ordered strictly before the existing orphan-cap/post-review rows so a push this task can
 *        cheapen never still falls through to the total-loss default.
 *
 * Five acceptance criteria, one test block each below, PLUS a `runSweep` end-to-end pair that
 * drives the two new dispositions through the dedup switch itself (the `"review-reused"`/
 * `"discriminate-only"` arm right beside `"wait"`/`"held-draft"` in that switch) — the ONLY way
 * to exercise those lines, since `deriveDisposition` alone never reaches `runSweep`'s own dedup
 * dispatch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  reviewReuseVerdict,
  runSweep,
  type OpenPrView,
  type ReviewReuseInputs,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { priorReviewVerdictFromLedger, reviewLedgerLegibilityFields } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { buildSweepEffects } from "../src/run-task.js";

const NOW = Date.parse("2026-09-16T19:00:00Z");
const RECENT = "2026-09-16T18:50:00Z";
const CURRENT_HEAD = "cafef00dcafef00dcafef00dcafef00dcafef00d";
const JUDGED_HEAD = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";
const TASK = "W1-T3704D";
const PR_URL = "https://github.com/craigoley/remudero/pull/3704";
const OWN_DIFF_DIGEST = "sha256:own-diff-abc123";
const MERGE_BASE = "0ldbase00ldbase00ldbase00ldbase00ldbase0";
const NEW_MERGE_BASE = "newbase1newbase1newbase1newbase1newbase1";
const CONTRACT_DIGEST = "contract-v1:unchanged-contract";

/** {@link ReviewReuseInputs} is declared OFF `OpenPrView` on purpose (see that type's own doc in
 *  sweep.ts) — no producer assigns any of its five keys onto a real `OpenPrView` yet, so a fixture
 *  here carries them as an overlay, the same shape `reviewReuseInputsFrom` reads off a real PR. */
type OrphanedPrFixture = Partial<OpenPrView> & Partial<ReviewReuseInputs>;

/** The exact shape a push-orphaned, checks-green review matches: `reviewState: "none"`,
 *  `checksState: "green"`, `reviewOrphanedByPush: true`, no unreadable required-contexts read. */
function orphanedPr(over: OrphanedPrFixture = {}): OpenPrView & Partial<ReviewReuseInputs> {
  return {
    prNumber: 3704,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: CURRENT_HEAD,
    autoMergeArmed: false,
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: 0,
    ...over,
  };
}

/** The full set of identity inputs {@link reviewReuseVerdict} compares, both sides equal — the
 *  "nothing a review reads has changed" shape (design row 1). */
function unchangedInputs(): Partial<ReviewReuseInputs> {
  return {
    reviewedOwnDiffDigest: OWN_DIFF_DIGEST,
    currentOwnDiffDigest: OWN_DIFF_DIGEST,
    reviewedMergeBaseSha: MERGE_BASE,
    currentMergeBaseSha: MERGE_BASE,
    reviewedHeadSha: JUDGED_HEAD,
    reviewedContractDigest: CONTRACT_DIGEST,
    currentContractDigest: CONTRACT_DIGEST,
  };
}

/** The minimal recording fake `runSweep` needs for these two dispositions: both route through the
 *  dedup switch's `"review-reused"`/`"discriminate-only"` arm, which forces `alreadyDone` true
 *  BEFORE any effector is ever reached — so every one of these calls must stay at zero. */
function minimalDeps(): SweepDeps & { armed: OpenPrView[]; closed: OpenPrView[]; fixed: OpenPrView[]; escalated: OpenPrView[] } {
  const armed: OpenPrView[] = [];
  const closed: OpenPrView[] = [];
  const fixed: OpenPrView[] = [];
  const escalated: OpenPrView[] = [];
  return {
    armed,
    closed,
    fixed,
    escalated,
    arm: (p) => { armed.push(p); },
    close: (p) => { closed.push(p); },
    dispatchFix: (p) => { fixed.push(p); },
    escalate: (p) => { escalated.push(p); },
    // THE SHARED BUILDER, not a 52nd ledger helper. `fixture-copy-census.test.ts` ratchets the
    // number of distinct ledger-helper names across test/, and this file's own `freshLedgerPath`
    // was one over (ledgerHelperNames: 52 > baseline 51). `writeLedger()` with no rows is the
    // same thing — a fresh tmp dir holding an empty `ledger.ndjson` — so `runSweep`'s
    // prior-actions fold still starts with every dedup set empty.
    ledgerPath: writeLedger().path,
    runId: "W1-T3704-REUSE",
  };
}

function modeDeps(): SweepDeps & { modes: string[] } {
  const base = minimalDeps();
  const modes: string[] = [];
  return {
    ...base,
    modes,
    postReview: async (_pr, mode) => {
      modes.push(mode?.kind ?? "full-review");
    },
  };
}

test("W1-T3798 production adapter posts reuse and routes discrimination through the fallback reviewer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-reuse-adapter-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-review-reuse-gh-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const oldPath = process.env.PATH;
  const calls: string[] = [];
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"pulls/3704"*) printf \'{"state":"open","merged":false,"head":{"sha":"cafef00dcafef00dcafef00dcafef00dcafef00d"},"body":""}\\n\' ;;',
      "  *) printf '{}\\n' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  appendLedger(ledgerPath, {
    run_id: "prior",
    task_id: TASK,
    step: "review.posted",
    state: "success",
    head_sha: JUDGED_HEAD,
    decision_verdict: { state: "success", criteria: [{ proof_exec: "executed_pass" }] },
    proof_exec: ["executed_pass"],
  });
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const effects = buildSweepEffects({
      owner: "acme",
      repo: "scratch",
      config: { root } as never,
      ledgerPath,
      runId: "reuse-adapter",
      plan: { tasks: [], byId: new Map() },
      log: (step) => calls.push(step),
      reviewRunner: async () => {
        calls.push("fallback-review");
        return 0;
      },
    });
    await withLiveWritesAllowed(() =>
      effects.postReview!(
        orphanedPr({ taskId: TASK }),
        { kind: "reuse", judgedHeadSha: JUDGED_HEAD },
      ),
    );
    assert.ok(calls.includes("sweep.post_review.done"), "reuse must post a durable current-head verdict");

    await effects.postReview!(orphanedPr({ taskId: TASK }), { kind: "discriminate-only", judgedHeadSha: JUDGED_HEAD });
    assert.ok(calls.includes("fallback-review"), "base-only changes must run the existing reviewer fallback");

    await effects.postReview!(orphanedPr({ taskId: undefined }), { kind: "reuse", judgedHeadSha: JUDGED_HEAD });
    assert.equal(calls.filter((step) => step === "fallback-review").length, 2, "unreadable evidence falls back too");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("W1-T3798 reuse-posts-current-head-verdict", async () => {
  const deps = modeDeps();
  const summary = await runSweep([orphanedPr(unchangedInputs())], deps);
  assert.equal(summary.byDisposition["review-reused"], 1);
  assert.deepEqual(deps.modes, ["reuse"]);
  const disposed = readLedgerLines(deps.ledgerPath).find((line) => line.step === "sweep.disposed");
  assert.equal(disposed?.acted, true);
});

test("W1-T3798 base-only-runs-discrimination", async () => {
  const deps = modeDeps();
  const summary = await runSweep([orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: NEW_MERGE_BASE })], deps);
  assert.equal(summary.byDisposition["discriminate-only"], 1);
  assert.deepEqual(deps.modes, ["discriminate-only"]);
});

test("W1-T3798 changed-contract-forces-full-review", async () => {
  const deps = modeDeps();
  await runSweep([orphanedPr({ ...unchangedInputs(), currentContractDigest: "contract-v1:changed-contract" })], deps);
  assert.deepEqual(deps.modes, ["full-review"]);
});

test("W1-T3798 unreadable-evidence-falls-back", async () => {
  const deps = modeDeps();
  await runSweep([orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: undefined })], deps);
  assert.deepEqual(deps.modes, ["full-review"]);
});

// ── acceptance 1: own diff same, merge base same → reuse the verdict ──────────────────────────

test("W1-T3704 (1): a push whose own diff and merge base are both unchanged reuses the verdict instead of discarding it", () => {
  const pr = orphanedPr(unchangedInputs());

  assert.deepEqual(reviewReuseVerdict(pr), { kind: "reuse", judgedHeadSha: JUDGED_HEAD });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "review-reused", "reused, never routed to a full re-review");
  assert.notEqual(result.disposition, "post-review", "the discarded-verdict default must not fire here");
});

// ── acceptance 1 (runSweep, the dedup switch itself): a reused verdict fires no effect ─────────

test("W1-T3704 (1, runSweep): a reused verdict takes NO gated action — every effector call stays at zero, ledgered acted:false", async () => {
  const deps = minimalDeps();
  const summary = await runSweep([orphanedPr(unchangedInputs())], deps);

  assert.equal(summary.byDisposition["review-reused"], 1);
  assert.equal(summary.actionsTaken, 0, "a reused verdict is never counted as an action taken");
  assert.equal(deps.armed.length, 0, "no auto-merge arm");
  assert.equal(deps.closed.length, 0, "no close");
  assert.equal(deps.fixed.length, 0, "no fix/review re-dispatch — the point of reusing the verdict");
  assert.equal(deps.escalated.length, 0, "no escalation");

  const disposed = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.disposition, "review-reused");
  assert.equal(disposed?.acted, false, "the disposition is ledgered, but nothing fired");
  assert.match(String(disposed?.reason), /reusing that verdict/);
});

test("W1-T3704 (2, runSweep): a discriminate-only verdict likewise takes no gated action — the re-discrimination dispatch is a separate, not-yet-wired producer", async () => {
  const deps = minimalDeps();
  const pr = orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: NEW_MERGE_BASE });
  const summary = await runSweep([pr], deps);

  assert.equal(summary.byDisposition["discriminate-only"], 1);
  assert.equal(summary.actionsTaken, 0);
  assert.equal(deps.armed.length, 0);
  assert.equal(deps.closed.length, 0);
  assert.equal(deps.fixed.length, 0);
  assert.equal(deps.escalated.length, 0);

  const disposed = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.disposition, "discriminate-only");
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.reason), /discrimination alone/);
});

test("W1-T3798 (dedup): a review-reused verdict already DELIVERED for this current head is not re-posted", async () => {
  const deps = modeDeps();
  deps.ledgerPath = writeLedger([
    { step: "review.posted", task_id: TASK, head_sha: CURRENT_HEAD },
  ]).path;
  const pr = orphanedPr(unchangedInputs());
  const summary = await runSweep([pr], deps);

  assert.equal(summary.byDisposition["review-reused"], 1);
  assert.equal(summary.actionsTaken, 0);
  assert.deepEqual(deps.modes, [], "the reuse post is deduped, not sent a second time for this head");

  const disposed = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /already DELIVERED/);
  assert.match(String(disposed?.stand_down_reason), /the reuse post is deduped/);
});

test("W1-T3798 (dedup): a discriminate-only verdict already REFUSED for this current head is not re-run, and is never conflated with delivered", async () => {
  const deps = modeDeps();
  deps.ledgerPath = writeLedger([
    { step: "review.post_refused", task_id: TASK, head_sha: CURRENT_HEAD, reason: "no acceptance criteria" },
  ]).path;
  const pr = orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: NEW_MERGE_BASE });
  const summary = await runSweep([pr], deps);

  assert.equal(summary.byDisposition["discriminate-only"], 1);
  assert.equal(summary.actionsTaken, 0);
  assert.deepEqual(deps.modes, []);

  const disposed = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /already REFUSED/);
  assert.doesNotMatch(String(disposed?.stand_down_reason), /DELIVERED/);
});

// ── acceptance 2: own diff same, merge base moved → discrimination only ───────────────────────

test("W1-T3704 (2): a push that only moves the merge base re-runs discrimination alone rather than the whole review", () => {
  const pr = orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: NEW_MERGE_BASE });

  assert.deepEqual(reviewReuseVerdict(pr), { kind: "discriminate-only", judgedHeadSha: JUDGED_HEAD });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "discriminate-only");
  assert.notEqual(result.disposition, "post-review", "a base-only move is cheaper than a full review");
  assert.match(result.reason, /discrimination alone/i);
});

// ── acceptance 3: any change to the own diff is a full re-review, no threshold of smallness ────

test("W1-T3704 (3): any change to the pull request's own diff still takes a full re-review, so no threshold of smallness exists", () => {
  const changedDiffCases: Array<OrphanedPrFixture> = [
    // own diff changed, merge base unchanged
    { ...unchangedInputs(), currentOwnDiffDigest: "sha256:own-diff-DIFFERENT" },
    // own diff changed AND merge base moved — still full review, never "discriminate-only"
    { ...unchangedInputs(), currentOwnDiffDigest: "sha256:own-diff-DIFFERENT", currentMergeBaseSha: NEW_MERGE_BASE },
  ];

  for (const over of changedDiffCases) {
    const pr = orphanedPr(over);
    assert.deepEqual(reviewReuseVerdict(pr), { kind: "full-review" });

    const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    // Falls through, unmodified, to the existing orphaned-by-push post-review row (or the cap row
    // once `priorReviewAttemptsForInput` reaches the cap — neither is "review-reused"/"discriminate-only").
    assert.notEqual(result.disposition, "review-reused");
    assert.notEqual(result.disposition, "discriminate-only");
  }
});

// ── acceptance 4: a reused verdict names the head it originally judged ─────────────────────────

test("W1-T3704 (4): a reused verdict names the head it originally judged, so reuse is auditable rather than silent", () => {
  const pr = orphanedPr(unchangedInputs());
  const verdict = reviewReuseVerdict(pr);
  assert.equal(verdict.kind, "reuse");
  assert.equal(verdict.kind === "reuse" ? verdict.judgedHeadSha : undefined, JUDGED_HEAD);

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.match(
    result.reason,
    new RegExp(JUDGED_HEAD.slice(0, 7)),
    "the disposition reason names the ORIGINALLY judged head, not the current one",
  );
  assert.doesNotMatch(result.reason, new RegExp(CURRENT_HEAD.slice(0, 7)), "never the current head instead");

  // The discriminate-only kind names its judged head identically.
  const discriminateOnlyPr = orphanedPr({ ...unchangedInputs(), currentMergeBaseSha: NEW_MERGE_BASE });
  const discriminateResult = deriveDisposition(discriminateOnlyPr, DEFAULT_SWEEP_POLICY, NOW);
  assert.match(discriminateResult.reason, new RegExp(JUDGED_HEAD.slice(0, 7)));
});

// ── acceptance 5: unreadable evidence refuses to reuse, falling back to a full re-review ──────

test("W1-T3704 (5): an unreadable diff or unresolvable merge base falls back to a full re-review rather than reusing on incomplete evidence", () => {
  const missingOneField: Array<OrphanedPrFixture> = [
    { ...unchangedInputs(), reviewedOwnDiffDigest: undefined },
    { ...unchangedInputs(), currentOwnDiffDigest: undefined },
    { ...unchangedInputs(), reviewedMergeBaseSha: undefined },
    { ...unchangedInputs(), currentMergeBaseSha: undefined },
    { ...unchangedInputs(), reviewedHeadSha: undefined },
    // nothing recorded at all — a line that predates every one of these fields
    {},
  ];

  for (const over of missingOneField) {
    const pr = orphanedPr(over);
    assert.deepEqual(reviewReuseVerdict(pr), { kind: "full-review" });

    const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.notEqual(result.disposition, "review-reused");
    assert.notEqual(result.disposition, "discriminate-only");
  }
});

// ── design (i): review.ts records what a verdict judged, round-tripped through the ledger ─────

test("W1-T3704 (design i): review.posted records own_diff_digest/merge_base_sha, and priorReviewVerdictFromLedger reads them back", () => {
  const fields = reviewLedgerLegibilityFields({
    capped: false,
    keywordOnly: false,
    planOnly: false,
    ownDiffDigest: OWN_DIFF_DIGEST,
    mergeBaseSha: MERGE_BASE,
  });
  assert.equal(fields.own_diff_digest, OWN_DIFF_DIGEST);
  assert.equal(fields.merge_base_sha, MERGE_BASE);

  const ledgerLine = {
    step: "review.posted",
    task_id: TASK,
    head_sha: JUDGED_HEAD,
    state: "success" as const,
    ...fields,
  };
  const prior = priorReviewVerdictFromLedger([ledgerLine], TASK);
  assert.equal(prior?.ownDiffDigest, OWN_DIFF_DIGEST);
  assert.equal(prior?.mergeBaseSha, MERGE_BASE);
  assert.equal(prior?.headSha, JUDGED_HEAD);
});

test("W1-T3704 (design i): an older review.posted line with neither key reads back UNDEFINED, not a false-ish default", () => {
  const fields = reviewLedgerLegibilityFields({ capped: false, keywordOnly: false, planOnly: false });
  assert.equal("own_diff_digest" in fields, false, "absent from the line, never written as undefined");
  assert.equal("merge_base_sha" in fields, false);

  const legacyLine = { step: "review.posted", task_id: TASK, head_sha: JUDGED_HEAD, state: "success" as const };
  const prior = priorReviewVerdictFromLedger([legacyLine], TASK);
  assert.equal(prior?.ownDiffDigest, undefined);
  assert.equal(prior?.mergeBaseSha, undefined);
});
