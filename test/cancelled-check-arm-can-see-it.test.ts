import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  cancelledCheckRequeueDecision,
  cancelledRequiredCheckNames,
  checksStateFromRollup,
  requeuedCheckKeysFromLedger,
  runSweep,
  type CancelledRequiredCheck,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { buildOpenPrViews, buildSweepEffects, cancelledRequiredChecks, fetchCiFailures } from "../src/run-task.js";
import { readLedgerLines } from "../src/lib/status.js";
import { REVIEW_CONTEXT } from "../src/lib/review.js";

/**
 * W1-T2283 — THE RE-QUEUE ARM NAMES ONLY A CHECK THAT NEVER GETS CANCELLED.
 *
 * `cancelledRequiredCheckNames` (lib/sweep.ts) used to narrow its candidate set to
 * `requiredContexts` BEFORE testing for the literal CANCELLED conclusion. On THIS repository,
 * branch protection names exactly two required contexts — `remudero-review` and `ci-gate` — so
 * that narrowing left a candidate set of one name. The check that actually gets cancelled,
 * `coverage-ratchet`, is a sibling `ci-gate` (the aggregate) depends on, not itself a declared
 * required context, and `ci-gate` reports its OWN conclusion as FAILURE — never CANCELLED — when
 * a sibling it depends on is cancelled. So the arm's candidate set never contained the one check
 * that was ever actually cancelled: two independent refusals, measured live on #2794 and #2841
 * across 49 sweep passes, zero re-queues, and one strike cap burned through on a diff carrying no
 * defect.
 *
 * Both incidents' job ids, conclusions and timestamps below are the real measured figures from
 * the task record's own rationale (2); everything here is an offline rollup fixture, no network.
 *
 * Nine acceptance claims, each proven below:
 *   1. the arm names the cancelled check on #2794's rollup, where the cancelled job is not one of
 *      the declared required contexts.
 *   2. the arm names it on #2841's rollup too — a different PR, recorded hours later.
 *   3. a required check that genuinely failed (no accompanying cancellation) is never named — a
 *      real defect still reaches the fix rung.
 *   4. a cancelled attempt superseded by a later attempt on the same head is never named.
 *   5. a cancellation observed while the aggregate has not yet concluded is carried, not discarded.
 *   6. the once-per-(head sha, check name) bound is unchanged — a second cancellation escalates.
 *   7. the re-queue target is still the single job, never the workflow run.
 *   8. `requiredContexts` is read and never written, and `REVIEW_CONTEXT` stays excluded.
 *   9. the fix rung spends no strike on a PR whose entire red verdict traces to a cancellation.
 */

const OWNER = "craigoley";
const REPO = "remudero";
// Branch protection's OWN declared required contexts, read live (rationale (1)) — NEITHER
// incident's cancelled check, `coverage-ratchet`, is a member of this list.
const REAL_REQUIRED = ["ci-gate", "remudero-review"];

// ── the two measured incidents, as offline rollup fixtures ─────────────────────────────────────

const INCIDENT_2794 = {
  prNumber: 2794,
  headSha: "sha-2794-abcdef",
  rollup: [
    {
      name: "coverage-ratchet",
      conclusion: "CANCELLED",
      startedAt: "2026-08-25T02:19:16Z",
      detailsUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/17600000001/job/97655132319`,
    },
    {
      name: "ci-gate",
      conclusion: "FAILURE",
      startedAt: "2026-08-25T02:29:39Z",
      detailsUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/17600000001/job/97655131652`,
    },
  ],
};

const INCIDENT_2841 = {
  prNumber: 2841,
  headSha: "sha-2841-fedcba",
  rollup: [
    {
      name: "coverage-ratchet",
      conclusion: "CANCELLED",
      startedAt: "2026-08-25T16:14:56Z",
      detailsUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/17600500002/job/97865158457`,
    },
    {
      name: "ci-gate",
      conclusion: "FAILURE",
      startedAt: "2026-08-25T16:25:24Z",
      detailsUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/17600500002/job/97865158300`,
    },
  ],
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-cancelled-arm-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: INCIDENT_2794.prNumber,
    prUrl: `https://github.com/${OWNER}/${REPO}/pull/${INCIDENT_2794.prNumber}`,
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-25T02:30:00Z",
    headSha: INCIDENT_2794.headSha,
    headRefName: "run-W1-TX-1785378652634",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
  requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }>;
  cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  const requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }> = [];
  const cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }> = [];
  return {
    fixed,
    escalated,
    requeued,
    cancelledEscalated,
    arm: () => {},
    close: () => {},
    dispatchFix: (p, evidence) => {
      fixed.push({ pr: p, evidence });
    },
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    requeueCheck: async (p, check) => {
      requeued.push({ pr: p, check });
    },
    escalateCancelledCheck: async (p, check, reason) => {
      cancelledEscalated.push({ pr: p, check, reason });
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-CANCELLED-ARM-1",
    now: () => Date.parse("2026-08-25T02:30:00Z"),
    ...overrides,
  };
}

// ── acceptance 1 — the arm names the cancelled check on #2794's rollup ──────────────────────────

test("acceptance 1: #2794 — coverage-ratchet CANCELLED, ci-gate FAILURE, required=[ci-gate,remudero-review] — the arm names coverage-ratchet even though it is NOT a declared required context", () => {
  assert.equal(
    REAL_REQUIRED.includes("coverage-ratchet"),
    false,
    "coverage-ratchet is not one of the two declared required contexts on this repo",
  );
  assert.deepEqual(cancelledRequiredCheckNames(INCIDENT_2794.rollup, REAL_REQUIRED), ["coverage-ratchet"]);

  const cancelled = cancelledRequiredChecks(INCIDENT_2794.rollup, REAL_REQUIRED);
  assert.deepEqual(cancelled.map((c) => c.name), ["coverage-ratchet"]);
  assert.equal(cancelled[0].jobId, "97655132319", "the job id parsed off coverage-ratchet's OWN detailsUrl");
});

// ── acceptance 2 — the arm names it on #2841's rollup too, a different PR, hours later ──────────

test("acceptance 2: #2841 — the SAME shape on a DIFFERENT pull request, recorded hours after #2794", () => {
  assert.ok(
    Date.parse(INCIDENT_2841.rollup[0].startedAt) > Date.parse(INCIDENT_2794.rollup[0].startedAt),
    "the second incident's cancellation is recorded strictly after the first's",
  );
  assert.notEqual(INCIDENT_2841.prNumber, INCIDENT_2794.prNumber, "a different pull request");

  assert.deepEqual(cancelledRequiredCheckNames(INCIDENT_2841.rollup, REAL_REQUIRED), ["coverage-ratchet"]);
  const cancelled = cancelledRequiredChecks(INCIDENT_2841.rollup, REAL_REQUIRED);
  assert.equal(cancelled[0].jobId, "97865158457");
});

// ── acceptance 3 — a required check that genuinely failed is never named ────────────────────────

test("acceptance 3: ci-gate FAILURE with NO accompanying cancellation is never named — a real defect still reaches the fix rung", () => {
  const rollup: RollupCheckEntry[] = [{ name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-25T01:00:00Z" }];
  assert.equal(checksStateFromRollup(rollup, REAL_REQUIRED), "red");
  assert.deepEqual(cancelledRequiredCheckNames(rollup, REAL_REQUIRED), [], "a bad verdict is not an absent one");
});

test("acceptance 3 (end to end): a genuinely failing required check still dispatches the fix rung, never a re-queue", async () => {
  const deps = fakeDeps();
  const rollup: RollupCheckEntry[] = [{ name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-25T01:00:00Z" }];
  const subject = pr({
    ciFailures: fetchCiFailures(OWNER, REPO, rollup),
    cancelledRequiredChecks: cancelledRequiredChecks(rollup, REAL_REQUIRED),
  });
  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.requeued.length, 0, "nothing was cancelled — nothing to re-queue");
  assert.equal(deps.fixed.length, 1, "a genuine failure still routes to the fix rung, unchanged");
});

// ── acceptance 4 — a superseded cancelled attempt is never named ────────────────────────────────

test("acceptance 4: coverage-ratchet CANCELLED then re-run to SUCCESS on the SAME head — the superseded attempt is never named", () => {
  const rollup: RollupCheckEntry[] = [
    { name: "coverage-ratchet", conclusion: "CANCELLED", startedAt: "2026-08-25T02:19:16Z" },
    { name: "coverage-ratchet", conclusion: "SUCCESS", startedAt: "2026-08-25T02:37:42Z" },
    { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-25T02:40:00Z" },
  ];
  assert.deepEqual(
    cancelledRequiredCheckNames(rollup, REAL_REQUIRED),
    [],
    "the LATEST (deduped) attempt of coverage-ratchet is SUCCESS, not CANCELLED",
  );
});

// ── acceptance 5 — a cancellation observed while the aggregate is still pending is carried ──────

test("acceptance 5: ci-gate still IN PROGRESS (checksState 'pending', not yet 'red') — the cancellation is carried, not discarded", () => {
  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/\/pulls\?/.test(path) || /state=open/.test(path)) {
      return [
        {
          number: INCIDENT_2794.prNumber,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/${INCIDENT_2794.prNumber}`,
          head: { ref: "run-W1-TX-1785378652634", sha: INCIDENT_2794.headSha },
          updated_at: "2026-08-25T02:20:28Z",
          body: "Remudero-Task: W1-TX",
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/check-runs/.test(path)) {
      return {
        check_runs: [
          // ci-gate has NOT concluded yet — the aggregate is still running.
          { name: "ci-gate", status: "in_progress" },
          {
            name: "coverage-ratchet",
            status: "completed",
            conclusion: "cancelled",
            details_url: `https://github.com/${OWNER}/${REPO}/actions/runs/17600000001/job/97655132319`,
          },
        ],
      };
    }
    if (/\/status/.test(path)) return { statuses: [] };
    return [];
  };

  const views = buildOpenPrViews(OWNER, REPO, ledgerPath(), {
    fetch,
    requiredContexts: () => REAL_REQUIRED,
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].checksState, "pending", "the required aggregate has not concluded — not red yet");
  assert.deepEqual(
    (views[0].cancelledRequiredChecks ?? []).map((c) => c.name),
    ["coverage-ratchet"],
    "the cancellation is already visible on this SAME rollup read, before ci-gate ever concludes",
  );
});

// ── acceptance 6 — the once-per-(head sha, check name) bound is unchanged ───────────────────────

test("acceptance 6: cancelledCheckRequeueDecision — no prior ledger record re-queues; a prior record escalates instead", () => {
  const first = cancelledCheckRequeueDecision(false);
  assert.equal(first.requeue, true);
  assert.equal(first.escalate, false);
  const second = cancelledCheckRequeueDecision(true);
  assert.equal(second.requeue, false);
  assert.equal(second.escalate, true);
});

test("acceptance 6 (end to end): a SECOND pass over the SAME head sha, still cancelled, re-queues nothing and escalates instead", async () => {
  const first = fakeDeps();
  const subject = pr({
    ciFailures: fetchCiFailures(OWNER, REPO, INCIDENT_2794.rollup),
    cancelledRequiredChecks: cancelledRequiredChecks(INCIDENT_2794.rollup, REAL_REQUIRED),
  });
  await runSweep([subject], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.requeued.length, 1, "the FIRST cancellation re-queues");

  const line = readLedgerLines(first.ledgerPath).find((l) => l.step === "sweep.check_requeued");
  assert.ok(line, "the re-queue is ledgered before it can be repeated");
  assert.ok(requeuedCheckKeysFromLedger(readLedgerLines(first.ledgerPath)).has(`${INCIDENT_2794.headSha}@coverage-ratchet`));

  const second = fakeDeps({ ledgerPath: first.ledgerPath });
  await runSweep([subject], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.requeued.length, 0, "bounded — no second re-queue for the same (head sha, check) pair");
  assert.equal(second.cancelledEscalated.length, 1, "a human-facing escalation fires instead");
  assert.equal(second.cancelledEscalated[0].check.name, "coverage-ratchet");
  assert.match(second.cancelledEscalated[0].reason, /already re-queued once/);
  assert.equal(second.fixed.length, 0, "still never the fix rung — this PR carries no diff defect");
});

// ── acceptance 7 — the re-queue target is still the single job, never the workflow run ──────────

test("acceptance 7: buildSweepEffects().requeueCheck targets coverage-ratchet's OWN job, never the whole workflow run that also carries ci-gate's job", async () => {
  const captured: string[][] = [];
  const effects = buildSweepEffects(
    OWNER,
    REPO,
    { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "w1t2283-requeue-root-")) } as never,
    ledgerPath(),
    "SWEEP-CANCELLED-ARM-2",
    { tasks: [] } as never,
    () => {},
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    (file, args) => {
      captured.push([file, ...args]);
    },
  );

  const cancelled = cancelledRequiredChecks(INCIDENT_2794.rollup, REAL_REQUIRED);
  assert.equal(cancelled.length, 1);

  await effects.requeueCheck?.(
    {
      prNumber: INCIDENT_2794.prNumber,
      prUrl: `https://github.com/${OWNER}/${REPO}/pull/${INCIDENT_2794.prNumber}`,
      headSha: INCIDENT_2794.headSha,
    } as never,
    cancelled[0],
  );

  assert.equal(captured.length, 1, `expected exactly one gh invocation, got ${JSON.stringify(captured)}`);
  const argv = captured[0].join(" ");
  assert.match(argv, /actions\/jobs\/97655132319\/rerun/, `must target coverage-ratchet's own job — argv was ${argv}`);
  assert.doesNotMatch(argv, /97655131652/, "must never mention ci-gate's own job id (the aggregate, not the target)");
  assert.doesNotMatch(argv, /rerun-failed-jobs/, `must NEVER target the whole-run rerun-failed-jobs endpoint — argv was ${argv}`);
  assert.doesNotMatch(argv, /actions\/runs\/[^/]+\/rerun(?!-)/, `must never re-run the whole workflow run — argv was ${argv}`);
});

// ── acceptance 8 — requiredContexts is read, never written; REVIEW_CONTEXT stays excluded ───────

test("acceptance 8a: requiredContexts is only ever READ — a frozen (unwritable) array is accepted without throwing", () => {
  const frozen = Object.freeze([...REAL_REQUIRED]);
  assert.doesNotThrow(() => cancelledRequiredCheckNames(INCIDENT_2794.rollup, frozen));
  assert.deepEqual(cancelledRequiredCheckNames(INCIDENT_2794.rollup, frozen), ["coverage-ratchet"]);
  // still the original two names, in the original order — proof nothing was appended/removed.
  assert.deepEqual(frozen, ["ci-gate", "remudero-review"]);
});

test("acceptance 8b: REVIEW_CONTEXT stays excluded from the candidate set even when it is itself CANCELLED and declared required", () => {
  const rollup: RollupCheckEntry[] = [
    ...INCIDENT_2794.rollup,
    { name: REVIEW_CONTEXT, conclusion: "CANCELLED", startedAt: "2026-08-25T02:19:20Z" },
  ];
  const required = [...REAL_REQUIRED, REVIEW_CONTEXT];
  assert.deepEqual(
    cancelledRequiredCheckNames(rollup, required),
    ["coverage-ratchet"],
    "remudero-review is never a re-queue candidate — it is a status the fleet posts itself",
  );
});

// ── acceptance 9 — the fix rung spends no strike when the entire red verdict traces to a cancellation ──

test("acceptance 9: #2794 end to end — the fix rung spends NO strike; the sweep re-queues coverage-ratchet instead", async () => {
  const deps = fakeDeps();
  const ciFailures = fetchCiFailures(OWNER, REPO, INCIDENT_2794.rollup);
  // ci-gate is dropped as a downstream aggregator (W1-T2296); its CAUSE, coverage-ratchet, is
  // what the miner names.
  assert.deepEqual(ciFailures.map((f) => f.name), ["coverage-ratchet"]);

  const cancelled = cancelledRequiredChecks(INCIDENT_2794.rollup, REAL_REQUIRED);
  // Pre-fix, this would have read [] (coverage-ratchet is not a declared required context) and
  // `genuineFailures` below would have been left holding `["coverage-ratchet"]` — non-empty —
  // spending a fix-rung strike on a diff carrying no defect (rationale (5)/(7)).
  assert.deepEqual(cancelled.map((c) => c.name), ["coverage-ratchet"]);

  const genuineFailures = ciFailures.filter((f) => !cancelled.some((c) => c.name === f.name));
  assert.deepEqual(genuineFailures, [], "nothing genuine remains once the cancellation is correctly named");

  const subject = pr({ ciFailures, cancelledRequiredChecks: cancelled });
  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.requeued.length, 1, "the re-queue fires");
  assert.equal(deps.requeued[0].check.name, "coverage-ratchet");
  assert.equal(deps.fixed.length, 0, "the fix rung spends NO strike — this PR carries no diff defect");
  assert.equal(deps.escalated.length, 0, "no blocked-ambiguous escalation either");
});
