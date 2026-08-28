/**
 * test/light-pass-requeue-admission.test.ts — W1-T2430.
 *
 * THE DEFECT. `lightPassActionable` (`src/run-task.ts`) admits `blocked-fixable` only under
 * `fixRungAllowed`, because that disposition's action is `dispatchFix` — the only lane the
 * spend-and-capacity bound (W1-T1211) exists to gate (`src/lib/sweep.ts` records 3 dispatch lanes
 * + 3 review lanes; ONLY `dispatchFix` spawns a worker). But `blocked-fixable`'s own case now ALSO
 * carries the cancelled-check re-queue lane (W1-T1223): a PR whose entire red verdict is one or
 * more cancellations never reaches `dispatchFix` — it always stands down at
 * `runSweep`'s own "cancelled required check(s)" branch first — yet the gate refuses to admit it
 * at all on a light pass, so a cancelled `coverage-ratchet` sits unrequeued until the next full
 * sweep even though its remedy is one `POST actions/jobs/{id}/rerun` (no worktree, no worker, no
 * model tokens).
 *
 * THE FIX. `blockedFixableIsRequeueOnly` recomputes, off the SAME `OpenPrView` snapshot
 * `runSweep`'s own switch will evaluate, the EXACT fold that switch performs (cancelled checks
 * present, every `ciFailures` entry names one of them) — so a PR it accepts is PROVEN, not merely
 * hoped, to be structurally unable to reach `dispatchFix`. `buildSweepLightHook` splits open PRs
 * on this predicate into a second, narrower `runSweepLightPass` call whose `actionable` admits
 * `blocked-fixable` unconditionally via `lightPassActionable`'s new (default-false, so every
 * EXISTING 2-arg caller is untouched) third parameter — with `readCiGateRollup`/`reaggregateCiGate`
 * undefined so the unrelated stale-ci-gate reaggregate lane, ordered before the cancelled-check
 * block in that same `case`, cannot ALSO widen. Every other PR — including a `blocked-fixable` PR
 * with a genuine, non-cancelled failure — keeps going through the UNCHANGED, `fixRungAllowed`-gated
 * call, exactly as before this task.
 *
 * These tests never touch `src/lib/sweep.ts` (unmodified by this task) — they drive its real,
 * exported `runSweepLightPass`/`runSweep` with fake deps, wired the SAME way
 * `buildSweepLightHook` now wires them, to prove the composition end to end.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  isBlockedCi,
  runSweepLightPass,
  type CancelledRequiredCheck,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { blockedFixableIsRequeueOnly, lightPassActionable } from "../src/run-task.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t2430-")), "ledger.ndjson");
}

/** The golden blocked-fixable-by-CI shape, same field set `cancelled-required-check-requeue.test.ts` uses. */
function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3210,
    prUrl: "https://github.com/craigoley/remudero/pull/3210",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: "cafe3210",
    autoMergeArmed: false,
    ...over,
  };
}

/** A PR whose ENTIRE red verdict is a single cancelled required check — the #2434/#2444 shape. */
function pureCancellationPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    ciFailures: [{ name: "coverage-ratchet", logTail: "" }],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "12345" }],
    ...over,
  });
}

/** A PR red for a REAL reason — `ciFailures` names nothing cancelled. */
function genuineFailurePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 3211,
    headSha: "cafe3211",
    ciFailures: [{ name: "ci-gate", logTail: "assertion failed at line 1\n" }],
    cancelledRequiredChecks: [],
    ...over,
  });
}

/** A MIXED PR: one cancellation plus one genuine failure on the SAME head. */
function mixedFailurePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 3212,
    headSha: "cafe3212",
    ciFailures: [
      { name: "coverage-ratchet", logTail: "" },
      { name: "ci-gate", logTail: "assertion failed at line 7\n" },
    ],
    cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "67890" }],
    ...over,
  });
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
  requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }>;
  cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }>;
  rollupReads: OpenPrView[];
  reaggregated: OpenPrView[];
  logs: Array<{ step: string; extra?: Record<string, unknown> }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  const requeued: Array<{ pr: OpenPrView; check: CancelledRequiredCheck }> = [];
  const cancelledEscalated: Array<{ pr: OpenPrView; check: CancelledRequiredCheck; reason: string }> = [];
  const rollupReads: OpenPrView[] = [];
  const reaggregated: OpenPrView[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return {
    fixed,
    escalated,
    requeued,
    cancelledEscalated,
    rollupReads,
    reaggregated,
    logs,
    log: (step, extra) => {
      logs.push({ step, extra });
    },
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
    readCiGateRollup: async (p) => {
      rollupReads.push(p);
      return undefined;
    },
    reaggregateCiGate: async (p) => {
      reaggregated.push(p);
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-T2430-1",
    now: () => NOW,
    ...overrides,
  };
}

/**
 * Reproduces `buildSweepLightHook`'s own split-and-wire logic (src/run-task.ts) — the ONE thing
 * production actually does with `blockedFixableIsRequeueOnly`/`lightPassActionable` — so these
 * tests prove the real composition, not a paraphrase of it.
 */
async function runLightPassBatches(
  openPrs: OpenPrView[],
  fixRungAllowed: boolean,
  deps: SweepDeps,
): Promise<void> {
  const requeueOnlyPrs = openPrs.filter((p) => blockedFixableIsRequeueOnly(p));
  const requeueOnlyNumbers = new Set(requeueOnlyPrs.map((p) => p.prNumber));
  const restPrs = openPrs.filter((p) => !requeueOnlyNumbers.has(p.prNumber));
  const passes: Array<Promise<unknown>> = [
    runSweepLightPass(restPrs, { ...deps, actionable: (d) => lightPassActionable(d, fixRungAllowed) }, DEFAULT_SWEEP_POLICY),
  ];
  if (requeueOnlyPrs.length > 0) {
    passes.push(
      runSweepLightPass(
        requeueOnlyPrs,
        {
          ...deps,
          actionable: (d) => lightPassActionable(d, fixRungAllowed, true),
          readCiGateRollup: undefined,
          reaggregateCiGate: undefined,
        },
        DEFAULT_SWEEP_POLICY,
      ),
    );
  }
  await Promise.all(passes);
}

// ── blockedFixableIsRequeueOnly — the per-PR proof `dispatchFix` is unreachable ────────────────

test("blockedFixableIsRequeueOnly: TRUE for a PR whose entire red verdict is one cancelled required check", () => {
  assert.equal(blockedFixableIsRequeueOnly(pureCancellationPr()), true);
});

test("blockedFixableIsRequeueOnly: FALSE when checksState is not red (isBlockedCi false) even with cancelledRequiredChecks set", () => {
  assert.equal(isBlockedCi(pr({ checksState: "green" })), false);
  const subject = pr({ checksState: "green", cancelledRequiredChecks: [{ name: "coverage-ratchet", jobId: "1" }], ciFailures: [] });
  assert.equal(blockedFixableIsRequeueOnly(subject), false);
});

test("blockedFixableIsRequeueOnly: FALSE when there is no cancelled required check at all", () => {
  assert.equal(blockedFixableIsRequeueOnly(genuineFailurePr()), false);
});

test("blockedFixableIsRequeueOnly: FALSE for a MIXED PR — a cancellation alongside a genuine failure on the same head", () => {
  assert.equal(blockedFixableIsRequeueOnly(mixedFailurePr()), false, "a real defect remains — this PR must still wait for dispatchFix's own gate");
});

// ── lightPassActionable — the widened predicate, and every existing call site's behaviour ──────

test("lightPassActionable: every EXISTING 2-arg call is byte-identical to before this task (default requeueLaneOnly=false)", () => {
  assert.equal(lightPassActionable("post-review", false), true);
  assert.equal(lightPassActionable("post-review", true), true);
  assert.equal(lightPassActionable("blocked-fixable", true), true);
  assert.equal(lightPassActionable("blocked-fixable", false), false);
  assert.equal(lightPassActionable("conflicted", true), true);
  assert.equal(lightPassActionable("conflicted", false), false);
  for (const d of ["stale", "blocked-ambiguous", "dep-review", "mergeable", "wait"] as const) {
    assert.equal(lightPassActionable(d, true), false);
    assert.equal(lightPassActionable(d, false), false);
  }
});

test("lightPassActionable: requeueLaneOnly=true admits blocked-fixable even when fixRungAllowed is false", () => {
  assert.equal(lightPassActionable("blocked-fixable", false, true), true);
  // ...and changes nothing when fixRungAllowed was already true.
  assert.equal(lightPassActionable("blocked-fixable", true, true), true);
});

test("lightPassActionable: requeueLaneOnly=true never widens `conflicted` — its sole action is always dispatchFix", () => {
  assert.equal(lightPassActionable("conflicted", false, true), false);
});

test("lightPassActionable: requeueLaneOnly=true never widens any of the other four untouched lanes", () => {
  for (const d of ["stale", "blocked-ambiguous", "dep-review", "mergeable", "wait"] as const) {
    assert.equal(lightPassActionable(d, false, true), false);
    assert.equal(lightPassActionable(d, true, true), false);
  }
});

// ── acceptance 1 + 3: a light pass admits the re-queue lane, and its only action is one POST ───

test("acceptance 1+3: a light pass (fixRungAllowed=false) re-queues a PR whose entire red verdict is a cancellation, and dispatches no fix", async () => {
  const deps = fakeDeps();
  const subject = pureCancellationPr();
  await runLightPassBatches([subject], false, deps);

  assert.equal(deps.requeued.length, 1, "the cancelled-check re-queue lane fired");
  assert.equal(deps.requeued[0].check.name, "coverage-ratchet");
  assert.equal(deps.fixed.length, 0, "dispatchFix — the only lane that spawns a worker — never fired");
  assert.equal(deps.escalated.length, 0);
  assert.equal(deps.cancelledEscalated.length, 0);
  // The unrelated stale-ci-gate reaggregate lane must stay scoped out entirely — never even read.
  assert.equal(deps.rollupReads.length, 0, "readCiGateRollup must be undefined for the requeue-only batch");
  assert.equal(deps.reaggregated.length, 0);

  const line = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.check_requeued");
  assert.ok(line, "the re-queue is ledgered, exactly as a full sweep's would be");
});

// ── acceptance 2: the same pass still refuses to dispatch a fix when the fix rung is not allowed ─

test("acceptance 2: an ORDINARY blocked-fixable PR (no cancellation) still refuses dispatchFix on a light pass", async () => {
  const deps = fakeDeps();
  await runLightPassBatches([genuineFailurePr()], false, deps);
  assert.equal(deps.fixed.length, 0, "unchanged — fixRungAllowed still gates the ordinary lane");
  assert.equal(deps.requeued.length, 0, "nothing was cancelled — nothing to re-queue");
});

test("acceptance 2: a MIXED PR (cancellation + genuine failure) also refuses dispatchFix on a light pass — the conservative choice this task's design makes", async () => {
  const deps = fakeDeps();
  await runLightPassBatches([mixedFailurePr()], false, deps);
  assert.equal(deps.fixed.length, 0, "the genuine failure alongside the cancellation still never spends a fix-rung strike here");
  // This task's widening is scoped to the PURE-cancellation case only (blockedFixableIsRequeueOnly
  // is false for a mixed PR — see that predicate's own test above), so the mixed PR's cancellation
  // is deferred to the next full sweep exactly as before this task, never re-queued from a light pass.
  assert.equal(deps.requeued.length, 0);
});

test("acceptance 2 (differential): the SAME mixed/ordinary PRs DO dispatch once fixRungAllowed is true — the gate itself is untouched", async () => {
  const deps = fakeDeps();
  await runLightPassBatches([genuineFailurePr(), mixedFailurePr()], true, deps);
  assert.equal(deps.fixed.length, 2, "both still reach dispatchFix once the fix rung may act — W1-T1211's own gate, unchanged");
});

// ── acceptance 4: a pass with no cancelled check takes no action from the widened lane ─────────

test("acceptance 4: a PR with an EMPTY cancelledRequiredChecks list is never routed to the widened batch and takes no action", async () => {
  const deps = fakeDeps();
  const subject = pr({ checksState: "red", ciFailures: [], cancelledRequiredChecks: [] });
  assert.equal(blockedFixableIsRequeueOnly(subject), false);
  await runLightPassBatches([subject], false, deps);
  assert.equal(deps.requeued.length, 0);
  assert.equal(deps.fixed.length, 0);
  const disposed = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.acted, false, "stands down exactly as it did before this task");
});

// ── acceptance 5: the other light-pass lanes are admitted exactly as they were ──────────────────

test("acceptance 5: a quiet tick (no cancelled check anywhere) is byte-identical to before this task — one runSweepLightPass call, same admission", async () => {
  const deps = fakeDeps();
  const openPrs = [genuineFailurePr()];
  // The production split routes nothing into the requeue-only batch here, so `restPrs` IS
  // `openPrs` and the ONLY call made is the pre-existing one — proven by asserting there is
  // exactly one `sweep.pass`/`sweep.summary` heartbeat for this tick, never two.
  await runLightPassBatches(openPrs, false, deps);
  const passes = deps.logs.filter((l) => l.step === "sweep.pass");
  assert.equal(passes.length, 1, "exactly one runSweep call for this tick — no duplicated heartbeat");
});

test("acceptance 5: post-review admission fairness is unaffected — the requeue-only batch can never itself carry a post-review-eligible PR", async () => {
  // isBlockedCi(pr) is true for every PR blockedFixableIsRequeueOnly admits, and DISPOSITION_RULES
  // routes every isBlockedCi PR to blocked-fixable/blocked-ambiguous strictly before the
  // post-review row (src/lib/sweep.ts) — so this predicate can never select a post-review PR.
  const subject = pureCancellationPr();
  assert.equal(isBlockedCi(subject), true);
  assert.equal(blockedFixableIsRequeueOnly(subject), true);
});

// ── acceptance 6: the workflow comment names the step the hangs actually died on ────────────────

test("acceptance 6: ci.yml's coverage-ratchet band comment names 'Test with coverage' as where its own measured cancellations died, not npx playwright install", () => {
  const ciYmlPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
  const contents = readFileSync(ciYmlPath, "utf8");
  // `coverage-ratchet:` is the job key (line ~212) — search for ITS OWN "HEAVY band" comment
  // strictly after that point, never the `ci` job's own earlier copy (the one this job's comment
  // explicitly points readers at "for the full derivation").
  const jobStart = contents.indexOf("\n  coverage-ratchet:\n");
  assert.ok(jobStart >= 0, "the coverage-ratchet job must still exist");
  const bandCommentStart = contents.indexOf("W1-T1009: HEAVY band", jobStart);
  assert.ok(bandCommentStart >= 0, "the HEAVY band derivation comment must still exist on the coverage-ratchet job");
  const bandComment = contents.slice(bandCommentStart, bandCommentStart + 1200);
  assert.match(
    bandComment,
    /`Test with coverage`/,
    "the corrected comment must name the step the measured cancellations actually died on",
  );
  assert.doesNotMatch(
    bandComment,
    /This job carries the same `npx playwright install` step and hung on it/,
    "the false pointer (this job's OWN hang attributed to playwright) must be gone",
  );
});
